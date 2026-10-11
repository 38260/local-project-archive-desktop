"""升级问题回归：使用真实 API 和独立源码/数据库，不接触正式档案。"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
