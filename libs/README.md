# Local dependency provenance

The build expects two third-party JARs per Minecraft target in this folder. A checkout may not carry them: run `scripts/fetch-libs.sh` for the default 26.3 pair, or `scripts/fetch-libs.sh 26.2` or `scripts/fetch-libs.sh 26.1` for another target (Git Bash on Windows). The script downloads the pair and checks it against `checksums.sha256`, `checksums-26.2.sha256` or `checksums-26.1.sha256`; a JAR that is already present is only re-verified. The URLs and Modrinth version ids are in `gradle.properties` and `gradle/mc/<target>.properties`.

`fabric-carpet-26.3+v260915.jar` comes from the upstream Fabric Carpet `v26.3` GitHub release:

https://github.com/gnembon/fabric-carpet/releases/download/v26.3/fabric-carpet-26.3%2Bv260915.jar

GitHub published the asset with SHA-256 digest `7c40b93e807ed914064176898037117097446c6cc76e6a80a856c8bf7f7659f9`, the digest `checksums.sha256` records.

`voicechat-fabric-2.6.27+26.3.jar` comes from the Modrinth Simple Voice Chat release for Minecraft 26.3 / SVC 2.6.27 (version id `x9jLR94Q`):

https://cdn.modrinth.com/data/9eGKb6K1/versions/x9jLR94Q/voicechat-fabric-2.6.27%2B26.3.jar

Its SHA-256 digest is `9e1c93144a3f7498e546102f6786aea6e4992866c4c5d21bd2e0edb702399153`. The voice add-on already depends on the same Modrinth version as `maven.modrinth:9eGKb6K1:x9jLR94Q`. `checksums.sha256` is the build-enforced record for the default-target JARs.

Once the JARs are in place, verify both files from PowerShell at the repository root:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\libs\fabric-carpet-26.3+v260915.jar
Get-FileHash -Algorithm SHA256 -LiteralPath .\libs\voicechat-fabric-2.6.27+26.3.jar
.\gradlew.bat verifyLocalDependencies
```

When updating Carpet or Simple Voice Chat, download an exact tagged release asset from the upstream project. Review its published digest, replace the JAR, and update `checksums.sha256` in the same change.

Other Minecraft targets, with their checksums verified against GitHub's published release digest (Carpet) and Modrinth's published SHA-512 (Simple Voice Chat):

- 26.2: `fabric-carpet-26.2+v260616.jar` (Carpet `v26.2` release) and `voicechat-fabric-2.6.27+26.2.jar` (Modrinth version `ul3tRpKz`).
- 26.1.x: `fabric-carpet-26.1+v260402.jar` (Carpet `v26.1` release, declares Minecraft `>26.0`) and `voicechat-fabric-2.6.27+26.1.2.jar` (Modrinth version `PVub6ooe`, declares `26.1.x`).
