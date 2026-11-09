#!/usr/bin/env python3
"""
Build script for Gemini Chat Exporter.
Generates:
  1. dist/chrome/   - Pure Chromium Manifest V3 (no gecko settings)
  2. dist/firefox/  - Pure Firefox Manifest V3 (gecko settings)
  3. dist/gemini-chat-exporter-chrome.zip
  4. dist/gemini-chat-exporter-firefox.xpi
  5. dist/gemini-chat-exporter-firefox.zip
"""

import os
import json
import shutil
import zipfile

EXT_DIR = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(EXT_DIR, "dist")
CHROME_DIR = os.path.join(DIST_DIR, "chrome")
FIREFOX_DIR = os.path.join(DIST_DIR, "firefox")

EXCLUDED_FILES = {
    "build.py",
    "README.md",
    "LICENSE",
    ".gitignore",
    ".git",
    "manifest.json",
    "dist",
    "logger-server.js",
    "DELIVERY.md",
    "FINAL-REPORT.md",
    "GITHUB-PUBLISH.md",
    "PROJECT-SUMMARY.md",
    "TASKS.md",
    "TROUBLESHOOTING.md",
    "VERSION.md"
}

def copy_assets(dest_dir):
    os.makedirs(dest_dir, exist_ok=True)
    for item in os.listdir(EXT_DIR):
        if item in EXCLUDED_FILES or item.startswith(".") or item.endswith(".zip") or item.endswith(".xpi") or item.endswith(".md"):
            continue
        src_path = os.path.join(EXT_DIR, item)
        dst_path = os.path.join(dest_dir, item)
        if os.path.isdir(src_path):
            if os.path.exists(dst_path):
                shutil.rmtree(dst_path)
            shutil.copytree(src_path, dst_path)
        elif os.path.isfile(src_path):
            shutil.copy2(src_path, dst_path)

def create_zip(source_dir, zip_path):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(source_dir):
            for file in files:
                abs_path = os.path.join(root, file)
                rel_path = os.path.relpath(abs_path, source_dir)
                zf.write(abs_path, rel_path)
    print(f"  [Package] Created {os.path.basename(zip_path)} ({os.path.getsize(zip_path)} bytes)")

def build():
    print("=== Building Gemini Chat Exporter (Chrome & Firefox) ===")

    # 1. Clean dist
    if os.path.exists(DIST_DIR):
        shutil.rmtree(DIST_DIR)
    os.makedirs(CHROME_DIR, exist_ok=True)
    os.makedirs(FIREFOX_DIR, exist_ok=True)

    # 2. Read base manifest
    manifest_path = os.path.join(EXT_DIR, "manifest.json")
    with open(manifest_path, "r", encoding="utf-8") as f:
        base_manifest = json.load(f)

    # 3. Build Chrome Target
    copy_assets(CHROME_DIR)
    chrome_manifest = dict(base_manifest)
    chrome_manifest.pop("browser_specific_settings", None)
    with open(os.path.join(CHROME_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(chrome_manifest, f, indent=2)
    print("  [Chrome] Manifest V3 generated -> dist/chrome/manifest.json")

    # 4. Build Firefox Target
    copy_assets(FIREFOX_DIR)
    firefox_manifest = dict(base_manifest)
    with open(os.path.join(FIREFOX_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(firefox_manifest, f, indent=2)
    print("  [Firefox] Manifest V3 generated -> dist/firefox/manifest.json")

    # 5. Pack ZIP & XPI
    create_zip(CHROME_DIR, os.path.join(DIST_DIR, "gemini-chat-exporter-chrome.zip"))
    create_zip(FIREFOX_DIR, os.path.join(DIST_DIR, "gemini-chat-exporter-firefox.xpi"))
    create_zip(FIREFOX_DIR, os.path.join(DIST_DIR, "gemini-chat-exporter-firefox.zip"))

    print("\n=== Build Complete ===")
    print(f"  Chrome unpacked:  {CHROME_DIR}")
    print(f"  Firefox unpacked: {FIREFOX_DIR}")
    print(f"  Chrome zip:       {os.path.join(DIST_DIR, 'gemini-chat-exporter-chrome.zip')}")
    print(f"  Firefox XPI:      {os.path.join(DIST_DIR, 'gemini-chat-exporter-firefox.xpi')}")

if __name__ == "__main__":
    build()
