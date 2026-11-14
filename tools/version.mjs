// The single source of truth for the app version is app/src-tauri/tauri.conf.json.
// Cargo.toml must carry the same value; the release script writes both from here.
//
// CLI (used by app/release.ps1):
//   node tools/version.mjs current                 -> 0.4.1
//   node tools/version.mjs next patch              -> 0.4.2   (prints, writes nothing)
//   node tools/version.mjs check                   -> exit 1 when copies disagree
//   node tools/version.mjs assert-newer 0.4.1 0.4.2 -> exit 1 unless 0.4.2 > 0.4.1
//   node tools/version.mjs set 0.4.2               -> writes tauri.conf.json + Cargo.toml
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const KINDS = new Set(['patch', 'minor', 'major']);

export function parseVersion(text) {
    const match = VERSION_RE.exec(String(text ?? ''));
    if (!match) {
        throw new Error(`invalid version ${JSON.stringify(text)}: expected x.y.z`);
    }
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function bumpVersion(version, kind) {
    if (!KINDS.has(kind)) {
        throw new Error(`invalid bump ${JSON.stringify(kind)}: expected patch, minor or major`);
    }
    const v = parseVersion(version);
    if (kind === 'major') return `${v.major + 1}.0.0`;
    if (kind === 'minor') return `${v.major}.${v.minor + 1}.0`;
    return `${v.major}.${v.minor}.${v.patch + 1}`;
}

// The release script passes -Version through this so ordering has one definition.
export function assertNewer(current, next) {
    const a = parseVersion(current);
    const b = parseVersion(next);
    const diff = (b.major - a.major) || (b.minor - a.minor) || (b.patch - a.patch);
    if (diff > 0) return next;
    if (diff === 0) throw new Error(`version ${next} is already the current version`);
    throw new Error(`version ${next} is lower than ${current}`);
}

function tauriPath(root) {
    return join(root, 'app', 'src-tauri', 'tauri.conf.json');
}

function cargoPath(root) {
    return join(root, 'app', 'src-tauri', 'Cargo.toml');
}

function cargoLockPath(root) {
    return join(root, 'app', 'src-tauri', 'Cargo.lock');
}

// Returns the index of the `version = "..."` line inside [package], or -1.
function packageVersionLine(lines) {
    let inPackage = false;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^\s*\[package\]\s*$/.test(line)) {
            inPackage = true;
            continue;
        }
        if (inPackage && /^\s*\[/.test(line)) return -1;
        if (inPackage && /^\s*version\s*=\s*"[^"]*"/.test(line)) return i;
    }
    return -1;
}

export function readTauriVersion(root) {
    const file = tauriPath(root);
    const conf = JSON.parse(readFileSync(file, 'utf8'));
    parseVersion(conf.version);
    return conf.version;
}

export function readCargoVersion(root) {
    const file = cargoPath(root);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const index = packageVersionLine(lines);
    if (index < 0) throw new Error(`no [package] version in ${file}`);
    return lines[index].match(/version\s*=\s*"([^"]*)"/)[1];
}

// Cargo.lock repeats the root crate's version; cargo updates it, but only after
// a build, which would leave the release commit without it.
function lockVersionLine(lines) {
    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].trim() === 'name = "desktop-todo"') {
            for (let j = i + 1; j < lines.length && !/^\[\[package\]\]/.test(lines[j]); j += 1) {
                if (/^version = "[^"]*"/.test(lines[j].trim())) return j;
            }
            return -1;
        }
    }
    return -1;
}

export function readCargoLockVersion(root) {
    const file = cargoLockPath(root);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const index = lockVersionLine(lines);
    if (index < 0) throw new Error(`no desktop-todo package in ${file}`);
    return lines[index].match(/version = "([^"]*)"/)[1];
}

export function checkVersions(root) {
    const expected = readTauriVersion(root);
    const mismatches = [];
    for (const [label, read] of [
        ['Cargo.toml', readCargoVersion],
        ['Cargo.lock', readCargoLockVersion],
    ]) {
        try {
            const actual = read(root);
            if (actual !== expected) {
                mismatches.push(`${label} is ${actual}, expected ${expected}`);
            }
        } catch (error) {
            mismatches.push(`${label}: ${error.message}`);
        }
    }
    return { ok: mismatches.length === 0, mismatches };
}

function writeAtomic(file, text) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
}

// Writes the given version into both files, keeping their formatting.
export function writeVersions(root, version) {
    parseVersion(version);
    const tauriFile = tauriPath(root);
    const cargoFile = cargoPath(root);

    const tauriText = readFileSync(tauriFile, 'utf8');
    const nextTauri = tauriText.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
    if (nextTauri === tauriText) {
        throw new Error(`no "version" field in ${tauriFile}`);
    }

    const cargoLines = readFileSync(cargoFile, 'utf8').split(/\r?\n/);
    const index = packageVersionLine(cargoLines);
    if (index < 0) throw new Error(`no [package] version in ${cargoFile}`);
    cargoLines[index] = cargoLines[index].replace(/^(\s*version\s*=\s*)"[^"]*"/, `$1"${version}"`);

    const lockFile = cargoLockPath(root);
    const lockLines = readFileSync(lockFile, 'utf8').split(/\r?\n/);
    const lockIndex = lockVersionLine(lockLines);
    if (lockIndex < 0) throw new Error(`no desktop-todo package in ${lockFile}`);
    lockLines[lockIndex] = lockLines[lockIndex].replace(/^(\s*version = )"[^"]*"/, `$1"${version}"`);

    writeAtomic(tauriFile, nextTauri);
    writeAtomic(cargoFile, cargoLines.join('\n'));
    writeAtomic(lockFile, lockLines.join('\n'));
    return version;
}

function cli(argv) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const [command, first, second] = argv;
    try {
        if (command === 'current') {
            console.log(readTauriVersion(root));
            return 0;
        }
        if (command === 'next') {
            console.log(bumpVersion(readTauriVersion(root), first));
            return 0;
        }
        if (command === 'check') {
            const result = checkVersions(root);
            if (!result.ok) {
                for (const mismatch of result.mismatches) console.error(`version mismatch: ${mismatch}`);
                return 1;
            }
            console.log(`ok ${readTauriVersion(root)}`);
            return 0;
        }
        if (command === 'assert-newer') {
            console.log(assertNewer(first, second));
            return 0;
        }
        if (command === 'set') {
            console.log(writeVersions(root, first));
            return 0;
        }
        console.error('usage: node tools/version.mjs current | next <patch|minor|major> | check | assert-newer <current> <next> | set <x.y.z>');
        return 2;
    } catch (error) {
        console.error(`version: ${error.message}`);
        return 1;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = cli(process.argv.slice(2));
}
