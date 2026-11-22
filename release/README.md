# Release artifacts

Installers, portable executables and updater manifests are generated here by
`scripts/release.ps1`. Every version gets its own folder, so old builds never
mix with the working tree or with each other.

```
release/
  v0.4.0/
    Nexus-Mixer_0.4.0_x64-setup.exe      installer
    Nexus-Mixer_0.4.0_x64-setup.exe.sig  updater signature
    Nexus-Mixer_0.4.0_x64-portable.exe   single-file portable build
    Nexus-Mixer-0.4.0-portable.zip       portable archive
    latest.json                          updater manifest
    SHA256SUMS.txt
```

The binaries are intentionally ignored by Git; the public copies live on the
[GitHub Releases](https://github.com/roma1231jjj-cpu/Nexus-mixer/releases) page.
