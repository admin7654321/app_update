import json
import subprocess
import sys
import os
import re
import urllib.request
import urllib.parse

# configuration
PACKAGE_JSON = 'package.json'
ANDROID_BUILD_GRADLE = os.path.join('android', 'app', 'build.gradle')
CMD_BUILD = 'npm run build'

# GitHub Configuration (Update these)
GITHUB_USER = 'admin7654321'
GITHUB_REPO = 'dist_update'
GITHUB_BRANCH = 'main'
GITHUB_PUBLIC_PATH = f'https://raw.githubusercontent.com/{GITHUB_USER}/{GITHUB_REPO}/{GITHUB_BRANCH}/updates'

# Firebase Configuration (DEDICATED OTA NODE)
FIREBASE_RTDB_URL = "https://entersave1-default-rtdb.firebaseio.com/ota_update.json"

def _version_to_code(version: str) -> int:
    parts = version.split('.')
    while len(parts) < 3:
        parts.append('0')
    parts = parts[:3]
    try:
        major = int(parts[0]) if parts[0].isdigit() else 0
        minor = int(parts[1]) if parts[1].isdigit() else 0
        patch = int(parts[2]) if parts[2].isdigit() else 0
        return major * 10000 + minor * 100 + patch
    except (ValueError, IndexError):
        return 0

def update_android_build_gradle(version: str) -> bool:
    try:
        if not os.path.exists(ANDROID_BUILD_GRADLE):
            return True
        with open(ANDROID_BUILD_GRADLE, 'r', encoding='utf-8') as f:
            content = f.read()
        version_code = _version_to_code(version)
        new_content = re.sub(r'(\bversionName\s+")([^"]*)(")', rf'\g<1>{version}\g<3>', content)
        new_content = re.sub(r'(\bversionCode\s+)(\d+)', rf'\g<1>{version_code}', new_content)
        if new_content != content:
            with open(ANDROID_BUILD_GRADLE, 'w', encoding='utf-8') as f:
                f.write(new_content)
        return True
    except Exception as e:
        print(f"❌ Error updating android/app/build.gradle: {e}")
        return False

def bump_version():
    try:
        if not os.path.exists(PACKAGE_JSON):
            print(f"❌ File {PACKAGE_JSON} not found!")
            return False
        with open(PACKAGE_JSON, 'r', encoding='utf-8') as f:
            data = json.load(f)
        current_ver = data.get('version', '0.0.0')
        print(f"Current Version: {current_ver}")
        parts = current_ver.split('.')
        if len(parts) != 3: parts = [0, 0, 0]
        major, minor, patch = map(int, parts)
        patch += 1
        new_ver = f"{major}.{minor}.{patch}"
        data['version'] = new_ver
        with open(PACKAGE_JSON, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"Updated Version to: {new_ver}")
        if not update_android_build_gradle(new_ver):
            return False
        return new_ver
    except Exception as e:
        print(f"Error updating version: {e}")
        return False

def run_step(command, step_name):
    print(f"Running: {step_name}...")
    try:
        subprocess.check_call(command, shell=True)
        print(f"{step_name} completed.")
        return True
    except subprocess.CalledProcessError:
        print(f"{step_name} failed.")
        return False

def zip_dist(version):
    print(f"Creating update bundle for version {version}...")
    try:
        os.makedirs('updates', exist_ok=True)
        zip_file = f'updates/bundle-{version}.zip'
        zip_cmd = f'powershell "Compress-Archive -Path dist/* -DestinationPath {zip_file} -Force"'
        subprocess.check_call(zip_cmd, shell=True)
        return zip_file
    except Exception as e:
        print(f"Faliure creating zip: {e}")
        return False

def main():
    print("--- GitHub & Firebase OTA Deployment Script ---")
    
    # 1. Bump version
    new_ver = bump_version()
    if not new_ver: sys.exit(1)
        
    # 2. Build app
    if not run_step(CMD_BUILD, "Build & Obfuscate"): sys.exit(1)
        
    # 3. Create zip
    zip_path = zip_dist(new_ver)
    if not zip_path: sys.exit(1)

    # 4. Push to GiHub
    print(f"Pushing {zip_path} to GitHub...")
    git_cmds = [
        f'git add updates/bundle-{new_ver}.zip',
        f'git commit -m "Deployment: OTA Update Version {new_ver}"',
        f'git push origin {GITHUB_BRANCH}'
    ]
    for cmd in git_cmds:
        if not run_step(cmd, "Git Ops"):
            print("FAILED pushing to GitHub. Make sure git is configured and you have permissions.")
            sys.exit(1)

    # 5. Update Firebase with download link
    download_url = f"{GITHUB_PUBLIC_PATH}/bundle-{new_ver}.zip"
    print(f"Updating Firebase version info: {new_ver} -> {download_url}")
    
    try:
        data = json.dumps({"version": new_ver, "url": download_url}).encode('utf-8')
        req = urllib.request.Request(FIREBASE_RTDB_URL, data=data, method='PUT')
        req.add_header('Content-Type', 'application/json')
        with urllib.request.urlopen(req) as resp:
            if resp.status == 200:
                print(f"Firebase updated successfully.")
            else:
                print(f"Firebase update failed: {resp.status} - {resp.read().decode()}")
                sys.exit(1)
    except Exception as e:
        print(f"Error updating Firebase: {e}")
        sys.exit(1)
        
    print(f"Success! Version {new_ver} is now available for manual OTA.")

if __name__ == "__main__":
    main()
