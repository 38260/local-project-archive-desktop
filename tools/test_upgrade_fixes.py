"""升级问题回归：使用真实 API 和独立源码/数据库，不接触正式档案。"""
import json
from io import BytesIO
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import uuid


SOURCE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE_ROOT))


class UpgradeApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="tracelight-regression-")
        cls.root = Path(cls.temp.name).resolve()
        shutil.copytree(SOURCE_ROOT / "app", cls.root / "app",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        cls.base = f"http://127.0.0.1:{port}"
        cls.log = (cls.root / "server.log").open("wb")
        cls.server = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
             "--port", str(port)], cwd=cls.root, stdout=cls.log,
            stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        cls.addClassCleanup(cls.cleanup_server)
        for _ in range(100):
            try:
                _, health, _ = cls.request("GET", "/api/health")
                if Path(health["data_path"]).resolve() != cls.root / "data/projects.db":
                    raise AssertionError("测试实例数据目录不匹配")
                return
            except (OSError, urllib.error.URLError):
                if cls.server.poll() is not None:
                    raise RuntimeError((cls.root / "server.log").read_text(errors="replace"))
                time.sleep(0.1)
        raise RuntimeError("隔离测试服务启动超时")

    @classmethod
    def cleanup_server(cls):
        cls.server.terminate()
        try:
            cls.server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.server.kill()
            cls.server.wait()
        cls.log.close()
        cls.temp.cleanup()

    @classmethod
    def request(cls, method, path, body=None, headers=None):
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            headers = {"Content-Type": "application/json", **(headers or {})}
        req = urllib.request.Request(cls.base + path, data=body, method=method,
                                     headers=headers or {})
        try:
            response = urllib.request.urlopen(req, timeout=20)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            data = response.read()
            info = {k.lower(): v for k, v in response.headers.items()}
            if "application/json" in info.get("content-type", ""):
                data = json.loads(data)
            return response.status, data, info

    def setUp(self):
        self.project_path = self.root / ("project-" + uuid.uuid4().hex)
        self.project_path.mkdir()
        status, project, _ = self.request("POST", "/api/projects", {
            "path": str(self.project_path), "name": self.project_path.name})
        self.assertEqual(status, 201, project)
        self.pid = project["id"]
        self.addCleanup(self.request, "DELETE", f"/api/projects/{self.pid}")

    def upload(self, filename, data):
        boundary = uuid.uuid4().hex
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
                f"filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
                ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
        return self.request("POST", f"/api/projects/{self.pid}/flowchart/upload", body,
                            {"Content-Type": "multipart/form-data; boundary=" + boundary})

    def test_svg_document_is_sandboxed(self):
        svg = (b'<svg xmlns="http://www.w3.org/2000/svg"><script>'
               b'document.documentElement.setAttribute("data-regression", "executed")'
               b'</script><rect width="20" height="20"/></svg>')
        status, uploaded, _ = self.upload("workflow.svg", svg)
        self.assertEqual(status, 201, uploaded)
        url = uploaded["saved"]["url"]
        status, content, headers = self.request("GET", url)
        self.assertEqual(status, 200)
        self.assertEqual(content, svg)
        policy = headers["content-security-policy"]
        self.assertIn("sandbox", policy)
        self.assertNotIn("allow-scripts", policy)
        self.assertIn("default-src 'none'", policy)
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        status, _, cached = self.request("GET", url, headers={"If-None-Match": headers["etag"]})
        self.assertEqual(status, 304)
        self.assertEqual(cached["content-security-policy"], policy)

    def test_project_links_cannot_escape_root(self):
        outside = self.root / ("outside-" + uuid.uuid4().hex)
        outside.mkdir()
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>'
        (outside / "workflow.svg").write_bytes(svg)
        link = self.project_path / "linked"
        if os.name == "nt":
            subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(link), str(outside)],
                           check=True, capture_output=True)
            self.addCleanup(os.rmdir, link)
        else:
            link.symlink_to(outside, target_is_directory=True)
            self.addCleanup(link.unlink)
        status, flow, _ = self.request("GET", f"/api/projects/{self.pid}/flowchart")
        self.assertEqual(status, 200)
        self.assertEqual(flow["candidates"], [])
        rel = "linked/workflow.svg"
        status, _, _ = self.request("GET", f"/api/projects/{self.pid}/file?rel={rel}&raw=1")
        self.assertEqual(status, 422)
        status, _, _ = self.request("PUT", f"/api/projects/{self.pid}/flowchart-prefs",
                                    {"choice": {"kind": "auto", "rel": rel}})
        self.assertEqual(status, 422)
        status, _, _ = self.request("POST", f"/api/projects/{self.pid}/open-file", {"rel": rel})
        self.assertEqual(status, 422)
        (self.project_path / "flowchart.svg").write_bytes(svg)
        status, content, _ = self.request(
            "GET", f"/api/projects/{self.pid}/file?rel=flowchart.svg&raw=1")
        self.assertEqual((status, content), (200, svg))

    def test_html_export_embeds_auto_and_uploaded_flowcharts(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>'
        (self.project_path / "flowchart.svg").write_bytes(svg)
        url = f"/api/projects/{self.pid}/export-html"
        status, content, _ = self.request("GET", url)
        self.assertEqual(status, 200, content)
        self.assertIn(b"data:image/svg+xml;base64,", content)
        self.assertIn(b"flowchart.svg", content)
        status, uploaded, _ = self.upload("workflow.svg", svg)
        self.assertEqual(status, 201, uploaded)
        status, content, _ = self.request("GET", url)
        self.assertEqual(status, 200, content)
        self.assertIn(b"data:image/svg+xml;base64,", content)
        self.assertIn(uploaded["saved"]["file"].encode(), content)

    def test_import_remaps_launchers_and_flowchart_files(self):
        launchers = []
        for name in ("first", "second"):
            status, launcher, _ = self.request("POST", f"/api/projects/{self.pid}/launchers",
                {"name": name, "command": f"echo {name}", "mode": "console", "cwd": ""})
            self.assertEqual(status, 200, launcher)
            launchers.append(launcher)
        keys = [f"l:{launcher['id']}" for launcher in reversed(launchers)]
        hidden = ["s:console||echo hidden"]
        self.request("PUT", f"/api/projects/{self.pid}/launch-prefs",
                     {"order": keys, "primary": keys[0], "hidden": hidden})
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20"/></svg>'
        _, first_image, _ = self.upload("first.svg", svg)
        _, second_image, _ = self.upload("second.svg", svg)
        _, exported, _ = self.request("GET", "/api/export")
        item = next(p for p in exported["projects"] if p["id"] == self.pid)
        self.assertEqual({l["id"] for l in item["launchers"]}, {l["id"] for l in launchers})
        target_path = self.root / ("import-" + uuid.uuid4().hex)
        target_path.mkdir()
        item["path"] = str(target_path)
        # 目标 ID 目录已有同名文件时，不能覆盖它。
        existing = self.root / "data/flowcharts" / str(self.pid + 1) / second_image["saved"]["file"]
        existing.parent.mkdir(parents=True)
        existing.write_bytes(b"existing-media-must-stay")
        status, imported, _ = self.request("POST", "/api/import", {"projects": [item]})
        self.assertEqual(status, 200, imported)
        self.assertEqual(imported["imported"], 1)
        self.assertEqual(imported["warnings"], [])
        _, listing, _ = self.request("GET", "/api/projects")
        project = next(p for p in listing["projects"] if p["path"] == str(target_path))
        pid = project["id"]
        self.addCleanup(self.request, "DELETE", f"/api/projects/{pid}")
        _, launch, _ = self.request("GET", f"/api/projects/{pid}/launch")
        new_keys = {l["name"]: f"l:{l['id']}" for l in launch["launchers"]}
        self.assertEqual(launch["order"], [new_keys["second"], new_keys["first"]])
        self.assertEqual(launch["primary"], new_keys["second"])
        self.assertEqual(launch["hidden"], hidden)
        _, flow, _ = self.request("GET", f"/api/projects/{pid}/flowchart")
        self.assertEqual(flow["current"]["kind"], "custom")
        self.assertNotEqual(flow["current"]["file"], second_image["saved"]["file"])
        self.assertEqual(existing.read_bytes(), b"existing-media-must-stay")
        status, data, _ = self.request("GET", flow["current"]["url"])
        self.assertEqual((status, data), (200, svg))
        self.assertIn(first_image["saved"]["file"], {f["file"] for f in flow["custom_files"]})
        self.assertTrue((self.root / "data/flowcharts" / str(self.pid)
                         / second_image["saved"]["file"]).is_file())

    def test_legacy_import_keeps_entries_without_guessing_ids(self):
        path = self.root / ("legacy-" + uuid.uuid4().hex)
        path.mkdir()
        status, imported, _ = self.request("POST", "/api/import", {"projects": [{
            "path": str(path), "launchers": [
                {"name": "first", "command": "echo first"},
                {"name": "second", "command": "echo second"}],
            "launch_prefs": {"order": ["l:900", "l:800"], "primary": "l:800",
                             "hidden": ["s:console||echo hidden"]}}]})
        self.assertEqual(status, 200, imported)
        self.assertEqual(imported["imported"], 1)
        self.assertEqual(len(imported["warnings"]), 1)
        _, listing, _ = self.request("GET", "/api/projects")
        pid = next(p["id"] for p in listing["projects"] if p["path"] == str(path))
        self.addCleanup(self.request, "DELETE", f"/api/projects/{pid}")
        _, launch, _ = self.request("GET", f"/api/projects/{pid}/launch")
        self.assertEqual(len(launch["launchers"]), 2)
        self.assertEqual(launch["order"], [])
        self.assertIsNone(launch["primary"])
        self.assertEqual(launch["hidden"], ["s:console||echo hidden"])

    def test_legacy_import_matches_available_source(self):
        launchers = []
        for name in ("first", "second"):
            _, launcher, _ = self.request("POST", f"/api/projects/{self.pid}/launchers",
                {"name": name, "command": f"echo {name}", "mode": "console", "cwd": ""})
            launchers.append(launcher)
        keys = [f"l:{l['id']}" for l in reversed(launchers)]
        self.request("PUT", f"/api/projects/{self.pid}/launch-prefs",
                     {"order": keys, "primary": keys[0]})
        _, exported, _ = self.request("GET", "/api/export")
        item = next(p for p in exported["projects"] if p["id"] == self.pid)
        for launcher in item["launchers"]:
            launcher.pop("id")
        path = self.root / ("legacy-source-" + uuid.uuid4().hex)
        path.mkdir()
        item["path"] = str(path)
        _, imported, _ = self.request("POST", "/api/import", {"projects": [item]})
        self.assertEqual(imported["warnings"], [])
        _, listing, _ = self.request("GET", "/api/projects")
        pid = next(p["id"] for p in listing["projects"] if p["path"] == str(path))
        self.addCleanup(self.request, "DELETE", f"/api/projects/{pid}")
        _, launch, _ = self.request("GET", f"/api/projects/{pid}/launch")
        expected = [f"l:{l['id']}" for l in reversed(launch["launchers"])]
        self.assertEqual(launch["order"], expected)
        self.assertEqual(launch["primary"], expected[0])

    def test_auto_override_is_atomic_and_keeps_position(self):
        first, second = "s:console||echo first", "s:console||echo second"
        for primary in (None, first, second):
            status, created, _ = self.request("POST", f"/api/projects/{self.pid}/launchers", {
                "name": "edited", "command": "echo edited", "cwd": "", "mode": "console",
                "source_key": second,
                "override_prefs": {"order": [first, second], "primary": primary, "hidden": []}})
            self.assertEqual(status, 200, created)
            key = f"l:{created['id']}"
            _, launch, _ = self.request("GET", f"/api/projects/{self.pid}/launch")
            self.assertEqual(launch["order"], [first, key])
            self.assertEqual(launch["primary"], key if primary == second else primary)
            self.assertEqual(launch["hidden"], [second])
            self.request("DELETE", f"/api/projects/{self.pid}/launchers/{created['id']}")
        original = {"order": [first, second], "primary": first, "hidden": []}
        self.request("PUT", f"/api/projects/{self.pid}/launch-prefs", original)
        status, _, _ = self.request("POST", f"/api/projects/{self.pid}/launchers", {
            "name": "must-rollback", "command": "echo no-partial-save", "source_key": second,
            "override_prefs": {"order": [first, second], "primary": first,
                               "hidden": [f"s:console||echo hidden-{i}" for i in range(100)]}})
        self.assertEqual(status, 422)
        _, launch, _ = self.request("GET", f"/api/projects/{self.pid}/launch")
        self.assertEqual(launch["launchers"], [])
        self.assertEqual({k: launch[k] for k in original}, original)

    def test_invalid_upload_keeps_previous_picture(self):
        from tools.smoke_test import PNG_1PX
        status, saved, _ = self.upload("valid.png", PNG_1PX)
        self.assertEqual(status, 201, saved)
        current = saved["saved"]["file"]
        bad_crc = bytearray(PNG_1PX)
        bad_crc[PNG_1PX.index(b"IDAT") + 4] ^= 1
        for filename, data in (
                ("header.png", b"\x89PNG\r\n\x1a\n"),
                ("wrong.jpg", PNG_1PX), ("crc.png", bytes(bad_crc)),
                ("not-svg.svg", b'<?xml version="1.0"?><html/>'),
                ("broken.svg", b'<svg xmlns="http://www.w3.org/2000/svg">')):
            with self.subTest(filename=filename):
                status, _, _ = self.upload(filename, data)
                self.assertEqual(status, 422)
                _, flow, _ = self.request("GET", f"/api/projects/{self.pid}/flowchart")
                self.assertEqual(flow["current"]["file"], current)
                self.assertEqual(len(flow["custom_files"]), 1)


class ImageValidationTests(unittest.TestCase):
    def test_supported_formats_and_pixel_limit(self):
        from PIL import Image
        from app.services.flowchart import sniff_image
        for ext, fmt in ((".png", "PNG"), (".jpg", "JPEG"), (".jpeg", "JPEG"),
                         (".gif", "GIF"), (".bmp", "BMP"), (".webp", "WEBP")):
            with self.subTest(ext=ext):
                buffer = BytesIO()
                Image.new("RGB", (8, 8), "white").save(buffer, format=fmt)
                self.assertTrue(sniff_image(buffer.getvalue(), ext))
        buffer = BytesIO()
        Image.new("RGB", (8, 8), "white").save(buffer, format="PNG")
        with patch.object(Image, "MAX_IMAGE_PIXELS", 40):
            self.assertFalse(sniff_image(buffer.getvalue(), ".png"))
        self.assertTrue(sniff_image(b'<svg xmlns="http://www.w3.org/2000/svg"/>', ".svg"))

    def test_exact_flowchart_name_precedes_backup(self):
        from app.services.flowchart import detect_flowcharts
        from tools.smoke_test import PNG_1PX
        with tempfile.TemporaryDirectory(prefix="tracelight-priority-") as temp:
            root = Path(temp)
            for name in ("flowchart-backup.png", "workflow.png", "flowchart.png", "flow-chart.PNG"):
                (root / name).write_bytes(PNG_1PX)
            (root / "docs").mkdir()
            (root / "docs/flowchart.png").write_bytes(PNG_1PX)
            names = [item["rel"] for item in detect_flowcharts(temp)]
            self.assertEqual(names, ["flow-chart.PNG", "flowchart.png", "flowchart-backup.png",
                                     "workflow.png", "docs/flowchart.png"])


class AutostartTests(unittest.TestCase):
    def test_enable_disable_and_legacy_names(self):
        from app.services import autostart
        values = {}

        class Key:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

        def query(key, name):
            try:
                return values[name.casefold()], 1
            except KeyError:
                raise FileNotFoundError(name)

        def delete(key, name):
            try:
                del values[name.casefold()]
            except KeyError:
                raise FileNotFoundError(name)

        registry = types.SimpleNamespace(
            HKEY_CURRENT_USER=1, REG_SZ=1,
            OpenKey=lambda *args: Key(), CreateKey=lambda *args: Key(),
            QueryValueEx=query, DeleteValue=delete,
            SetValueEx=lambda key, name, reserved, kind, value:
                values.__setitem__(name.casefold(), value))
        command = '"D:/sample/tracelight.exe"'
        with patch.dict(sys.modules, {"winreg": registry}), \
                patch.object(autostart, "exe_command", return_value=command):
            self.assertTrue(autostart.set_enabled(True))
            self.assertTrue(autostart.get_enabled())
            self.assertEqual(values, {"tracelight": command})
            self.assertTrue(autostart.set_enabled(False))
            self.assertFalse(autostart.get_enabled())
            values["Tracelight".casefold()] = command
            self.assertTrue(autostart.get_enabled())
            values.clear()
            values["localprojectarchive"] = '"D:/old/LocalProjectArchive.exe"'
            autostart.self_heal()
            self.assertEqual(values, {"tracelight": command})


if __name__ == "__main__":
    unittest.main(verbosity=2)
