# -*- coding: utf-8 -*-
"""从 todo.pyw 的 APP_VERSION 生成 packaging/version_info.txt。

单一版本事实源：版本号只写在 todo.pyw 的 APP_VERSION 一处，
exe 文件属性（version resource）由 build.ps1 在每次构建前调用本脚本生成，
不再手工同步两份副本。

    py -3.12 packaging/gen_version_info.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TEMPLATE = """\
# UTF-8
# exe 文件属性里的版本信息(资源管理器 -> 属性 -> 详细信息)。
# 本文件由 packaging/gen_version_info.py 从 todo.pyw 的 APP_VERSION 生成, 勿手改。
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers=({v0}, {v1}, {v2}, {v3}),
    prodvers=({v0}, {v1}, {v2}, {v3}),
    mask=0x3f,
    flags=0x0,
    OS=0x40004,
    fileType=0x1,
    subtype=0x0,
    date=(0, 0),
  ),
  kids=[
    StringFileInfo([
      StringTable(
        "040904B0",
        [
          StringStruct("CompanyName", "zwxdogs"),
          StringStruct("FileDescription", "桌面待办 - 把 Markdown 待办清单固定在 Windows 桌面"),
          StringStruct("FileVersion", "{ver}"),
          StringStruct("InternalName", "DesktopTodo"),
          StringStruct("LegalCopyright", ""),
          StringStruct("OriginalFilename", "DesktopTodo.exe"),
          StringStruct("ProductName", "桌面待办"),
          StringStruct("ProductVersion", "{ver}"),
        ],
      )
    ]),
    VarFileInfo([VarStruct("Translation", [1033, 1200])]),
  ],
)
"""


def main():
    with open(os.path.join(ROOT, "todo.pyw"), encoding="utf-8") as f:
        src = f.read()
    m = re.search(r'APP_VERSION\s*=\s*"([\d.]+)"', src)
    if not m:
        sys.exit("APP_VERSION not found in todo.pyw")
    nums = [int(x) for x in m.group(1).split(".")]
    while len(nums) < 4:
        nums.append(0)
    out = os.path.join(ROOT, "packaging", "version_info.txt")
    with open(out, "w", encoding="utf-8") as f:
        f.write(TEMPLATE.format(ver=m.group(1), v0=nums[0], v1=nums[1],
                                v2=nums[2], v3=nums[3]))
    print("written: %s (version %s)" % (os.path.relpath(out, ROOT), m.group(1)))


if __name__ == "__main__":
    main()
