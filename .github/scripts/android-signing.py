#!/usr/bin/env python3
"""Restore a pinned debug key and verify the resulting downloadable APK."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


SECRET = 'HAPI_ANDROID_DEBUG_KEYSTORE_BASE64'
PACKAGE = 'run.hapi.companion'
FINGERPRINT_FILE = Path(__file__).resolve().parents[1] / 'android-debug-certificate.sha256'


def run(command, data=None):
    result = subprocess.run(command, input=data, capture_output=True)
    if result.returncode:
        # OpenSSL can handle private-key material: never echo its captured output.
        raise ValueError(f'{Path(command[0]).name} validation failed')
    return result.stdout


def fingerprint():
    value = FINGERPRINT_FILE.read_text().strip().lower()
    if not re.fullmatch(r'[0-9a-f]{64}', value):
        raise ValueError('Invalid pinned certificate SHA-256')
    return value


def prepare(keystore):
    encoded = os.environ.pop(SECRET, '').strip()
    if not encoded:
        raise ValueError(f'Set the repository Actions secret {SECRET}; no temporary key will be generated')
    if len(encoded) > 2 * 1024 * 1024:
        raise ValueError('Signing keystore exceeds the size limit')
    try:
        data = base64.b64decode(''.join(encoded.split()), validate=True)
    except ValueError:
        raise ValueError(f'{SECRET} is not valid base64') from None
    if not data or len(data) > 1024 * 1024:
        raise ValueError('Invalid signing keystore size')

    expected = fingerprint()
    keystore.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(prefix='.hapi-debug-', dir=keystore.parent)
    temporary = Path(name)
    try:
        # mkstemp creates a private (0600) file; replace only after validation.
        with os.fdopen(descriptor, 'wb') as output:
            output.write(data)
        pkcs12 = ['openssl', 'pkcs12', '-in', str(temporary), '-passin', 'pass:android']
        certificate = run(pkcs12 + ['-clcerts', '-nokeys'])
        private_key = run(pkcs12 + ['-nocerts', '-nodes'])
        for material in (certificate, private_key):
            aliases = re.findall(rb'friendlyName:\s*([^\r\n]+)', material)
            if [alias.strip().lower() for alias in aliases] != [b'androiddebugkey']:
                raise ValueError('The keystore must contain the standard androiddebugkey alias')
        der = run(['openssl', 'x509', '-outform', 'DER'], certificate)
        if hashlib.sha256(der).hexdigest() != expected:
            raise ValueError('The keystore certificate does not match the pinned SHA-256')
        public_key = run(['openssl', 'x509', '-pubkey', '-noout'], certificate)
        certificate_key = run(['openssl', 'pkey', '-pubin', '-outform', 'DER'], public_key)
        signing_key = run(['openssl', 'pkey', '-pubout', '-outform', 'DER'], private_key)
        if signing_key != certificate_key:
            raise ValueError('The signing key does not match its certificate')
        run(['openssl', 'x509', '-checkend', '86400', '-noout'], certificate)
        temporary.replace(keystore)
    finally:
        temporary.unlink(missing_ok=True)
    print(f'Fixed signing certificate verified: {expected}')


def build_tools():
    for variable in ('ANDROID_HOME', 'ANDROID_SDK_ROOT'):
        sdk = os.environ.get(variable)
        if not sdk:
            continue
        candidates = [
            path for path in (Path(sdk) / 'build-tools').glob('*')
            if re.fullmatch(r'\d+\.\d+\.\d+', path.name)
            and all((path / tool).is_file() for tool in ('apksigner', 'aapt2'))
        ]
        if candidates:
            return max(candidates, key=lambda path: tuple(map(int, path.name.split('.'))))
    raise ValueError('Android build-tools with apksigner and aapt2 are required on the CI runner')


def verify(apk, version_code, source_sha, report):
    if not 0 < version_code <= 2100000000:
        raise ValueError('Invalid APK version code')
    if not re.fullmatch(r'[0-9a-f]{40}', source_sha):
        raise ValueError('Invalid source commit SHA')
    expected = fingerprint()
    binaries = build_tools()
    signatures = run([str(binaries / 'apksigner'), 'verify', '--print-certs', str(apk)]).decode()
    signers = re.findall(r'^Signer #\d+ certificate SHA-256 digest:\s*([0-9a-fA-F]+)\s*$', signatures, re.MULTILINE)
    if [signer.lower() for signer in signers] != [expected]:
        raise ValueError('APK signer does not match the fixed certificate')
    badging = run([str(binaries / 'aapt2'), 'dump', 'badging', str(apk)]).decode()
    package = re.search(r"^package: name='([^']+)' versionCode='(\d+)'", badging, re.MULTILINE)
    if not package or package.group(1) != PACKAGE or int(package.group(2)) != version_code:
        raise ValueError('APK package or version code differs from the expected update identity')
    report.write_text(json.dumps({
        'packageName': PACKAGE,
        'versionCode': version_code,
        'sourceSha': source_sha,
        'certificateSha256': expected,
        'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
    }, indent=2) + '\n')
    print(f'Verified {PACKAGE}, versionCode={version_code}, certificate={expected}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    restore = commands.add_parser('prepare')
    restore.add_argument('--keystore', type=Path, required=True)
    check = commands.add_parser('verify')
    check.add_argument('--apk', type=Path, required=True)
    check.add_argument('--version-code', type=int, required=True)
    check.add_argument('--source-sha', required=True)
    check.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'prepare':
            prepare(args.keystore)
        else:
            verify(args.apk, args.version_code, args.source_sha, args.report)
    except (OSError, ValueError) as error:
        print(f'Android signing: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
