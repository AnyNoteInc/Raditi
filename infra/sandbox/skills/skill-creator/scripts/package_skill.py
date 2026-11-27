#!/usr/bin/env python3
"""Pack a checked skill folder into <name>.skill (a zip) for the client to save.

Usage: python3 package_skill.py <skill-folder> [output-folder, default /workspace/out]

The file lands in /workspace/out, so it comes to the chat when the answer ends; the client saves
it with «Сохранить как навык» on its card. The folder is checked first (quick_validate.py).

Written for Радити after package_skill.py of the skill-creator of Anthropic (Apache-2.0): see
NOTICE.
"""

import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from quick_validate import check, files_of  # noqa: E402


def main() -> int:
    if len(sys.argv) not in (2, 3):
        print("usage: python3 package_skill.py <skill-folder> [output-folder]")
        return 2
    root = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2] if len(sys.argv) == 3 else "/workspace/out").resolve()
    if not root.is_dir():
        print(f"{root}: not a folder")
        return 1
    errors = [p for p in check(root) if not p.endswith("(warning)")]
    if errors:
        for error in errors:
            print(error)
        print("fix these first")
        return 1
    out.mkdir(parents=True, exist_ok=True)
    target = out / f"{root.name}.skill"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, rel in files_of(root):
            if path.is_file() and not path.is_symlink():
                info = zipfile.ZipInfo.from_file(path, f"{root.name}/{rel.as_posix()}")
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, path.read_bytes())
    print(f"packed {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
