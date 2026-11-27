#!/usr/bin/env python3
"""Make the folder of a new skill with a SKILL.md to fill in.

Usage: python3 init_skill.py <name> [--path /workspace/out/skills] [--resources scripts,references,assets]

Written for Радити after init_skill.py of the skill-creator of OpenAI (Apache-2.0): see NOTICE.
"""

import argparse
import re
import sys
from pathlib import Path

NAME = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
RESOURCES = ("scripts", "references", "assets")
# Where a new skill may be made: the working folders of the turn, never a folder anyone may write
# to. The path comes from the model, so it is resolved and kept inside.
ROOT = Path("/workspace").resolve()

TEMPLATE = """---
name: {name}
description: 'TODO: what this skill does, and when to use it — the words the client would write. Use whenever …'
metadata:
  raditi-title: 'TODO: название навыка по-русски'
  raditi-summary: 'TODO: одно предложение — что делает навык'
---

# {title}

TODO: the instructions the agent follows when this skill loads.

## Steps

1. …

## Result

TODO: what the result looks like; one short example.
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Make the folder of a new skill.")
    parser.add_argument("name", help="lowercase Latin letters, digits and single hyphens")
    parser.add_argument("--path", default="/workspace/out/skills", help="the folder to make it in")
    parser.add_argument(
        "--resources",
        default="",
        help="folders to add, comma-separated: scripts,references,assets",
    )
    args = parser.parse_args()

    name = args.name.strip()
    if not NAME.match(name) or len(name) > 64:
        print("the name: lowercase Latin letters, digits and single hyphens, 1-64 characters")
        return 1
    resources = [r.strip() for r in args.resources.split(",") if r.strip()]
    unknown = [r for r in resources if r not in RESOURCES]
    if unknown:
        print(f"unknown folders: {', '.join(unknown)}; choose from {', '.join(RESOURCES)}")
        return 1

    base = Path(args.path).resolve()
    if base != ROOT and ROOT not in base.parents:
        print(f"--path must be inside {ROOT}")
        return 1
    folder = base / name
    if folder.exists():
        print(f"{folder} exists already")
        return 1
    folder.mkdir(parents=True)
    title = " ".join(part.capitalize() for part in name.split("-"))
    (folder / "SKILL.md").write_text(TEMPLATE.format(name=name, title=title), encoding="utf-8")
    for resource in resources:
        (folder / resource).mkdir()
    print(f"made {folder}/SKILL.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
