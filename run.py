"""启动入口：本地启动服务，浏览器访问 http://127.0.0.1:8300

用法：
  python run.py                # 默认端口 8300，自动打开浏览器
  python run.py --port 9000    # 指定端口
  python run.py --no-browser   # 不自动打开浏览器
"""
import argparse
import threading
import webbrowser

import uvicorn

from app.config import DEFAULT_PORT, HOST


def main() -> None:
    parser = argparse.ArgumentParser(description="归迹拾光管理系统")
    parser.add_argument("--port", type=int, default=0,
                        help=f"服务端口（默认 {DEFAULT_PORT}，被占用时自动挑选空闲端口）")
    parser.add_argument("--no-browser", action="store_true",
                        help="启动后不自动打开浏览器")
    args = parser.parse_args()

    from app.config import pick_port

    # 显式指定的端口必须原样使用；未指定则从默认端口起找第一个空闲的
    port = args.port or pick_port(preferred=DEFAULT_PORT)

    # 延迟导入：加载应用即完成数据库初始化
    from app.main import app

    url = f"http://{HOST}:{port}"
    # 仅绑定本机回环地址，不对外网暴露
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    print(f"归迹拾光服务已启动：{url}  （Ctrl+C 停止）")
    uvicorn.run(app, host=HOST, port=port, log_level="info")


if __name__ == "__main__":
    main()
