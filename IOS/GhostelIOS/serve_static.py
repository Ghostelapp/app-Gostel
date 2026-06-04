from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


def route_parts(root: Path, html_file: Path) -> list[str]:
    rel = html_file.relative_to(root).with_suffix("")
    parts = [
        part
        for part in rel.parts
        if not (part.startswith("(") and part.endswith(")"))
    ]
    return [] if parts == ["index"] else parts


def matches_route(pattern: list[str], request_parts: list[str]) -> bool:
    if len(pattern) != len(request_parts):
        return False

    for expected, actual in zip(pattern, request_parts):
        if expected.startswith("[") and expected.endswith("]"):
            continue
        if expected != actual:
            return False

    return True


class ExpoStaticHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        request_path = unquote(urlsplit(path).path)
        direct_path = Path(super().translate_path(request_path))
        if direct_path.exists():
            return str(direct_path)

        if request_path != "/" and not request_path.endswith("/"):
            html_path = Path(super().translate_path(f"{request_path}.html"))
            if html_path.exists():
                return str(html_path)

        request_parts = [part for part in request_path.strip("/").split("/") if part]
        if request_parts:
            root = Path(self.directory)
            for html_file in root.rglob("*.html"):
                pattern = route_parts(root, html_file)
                if matches_route(pattern, request_parts):
                    return str(html_file)

        return str(direct_path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=19006)
    args = parser.parse_args()

    root = Path(args.directory).resolve()
    handler = partial(ExpoStaticHandler, directory=str(root))

    with ThreadingHTTPServer((args.host, args.port), handler) as server:
        print(f"Serving HTTP on {args.host} port {args.port} (http://{args.host}:{args.port}/) ...")
        server.serve_forever()


if __name__ == "__main__":
    main()
