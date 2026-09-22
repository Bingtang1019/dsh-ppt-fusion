# Engine-side PNG renderer probe.
#
# The ppt-master exporter needs a PNG rasteriser for its Office compatibility
# mode. When none is importable it prints a warning and silently falls back to
# pure SVG mode, which Office LTSC 2021 and WPS may not display (plan 3.4/1.5).
#
# This probe reports the truth instead of trusting the import to have worked:
# `import cairosvg` raises OSError when the native cairo library is missing, and
# the upstream detector swallows exactly that error. It therefore also reports
# which distributions are installed and what the import failure said, so the
# report distinguishes "not installed" from "installed but broken" (M0.G).
#
# Usage: <venv python> python-assets/probe-png-renderer.py <engine scripts dir>
#
# Prints one JSON object:
#   {renderer, status, hint, installed, importError, converted, pngBytes, error}
import importlib.metadata as metadata
import json
import pathlib
import sys
import tempfile

scripts_dir = sys.argv[1] if len(sys.argv) > 1 else ""
if scripts_dir:
    sys.path.insert(0, scripts_dir)

WATCHED = ("cairosvg", "cairocffi", "pycairo", "svglib", "reportlab")


def installed_versions():
    versions = {}
    for name in WATCHED:
        try:
            versions[name] = metadata.version(name)
        except Exception:
            versions[name] = None
    return versions


result = {
    "renderer": None,
    "status": "",
    "hint": None,
    "installed": installed_versions(),
    "importError": None,
    "converted": False,
    "pngBytes": 0,
    "error": None,
}

# Record why cairosvg is unusable when it is installed but cannot import.
try:
    import cairosvg  # noqa: F401
except Exception as exc:
    if result["installed"].get("cairosvg") is not None:
        message = str(exc).strip().splitlines()
        result["importError"] = message[0] if message else repr(exc)

try:
    from svg_to_pptx.pptx_package import media
except Exception as exc:
    result["error"] = f"cannot import the engine media module: {exc!r}"
    print(json.dumps(result))
    sys.exit(0)

result["renderer"] = media.PNG_RENDERER
name, status, hint = media.get_png_renderer_info()
result["status"] = status
result["hint"] = hint

SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" viewBox="0 0 80 40">'
    '<rect width="80" height="40" fill="#123456"/>'
    '<text x="6" y="26" font-size="14" fill="#FFFFFF">ok</text></svg>'
)

workdir = pathlib.Path(tempfile.mkdtemp(prefix="dsh-ppt-renderer-"))
svg_path = workdir / "probe.svg"
png_path = workdir / "probe.png"
svg_path.write_text(SVG, encoding="utf-8")

if media.PNG_RENDERER is not None:
    try:
        result["converted"] = bool(media.convert_svg_to_png(svg_path, png_path))
        if png_path.exists():
            result["pngBytes"] = png_path.stat().st_size
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"

print(json.dumps(result))