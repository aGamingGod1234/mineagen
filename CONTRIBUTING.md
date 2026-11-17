# Contributing to Mineagen

Thanks for helping. This page covers the basics. [DEVELOPMENT.md](DEVELOPMENT.md) has the full build, test and release steps, and [AGENTS.md](AGENTS.md) has the rules for AI agents working on the code.

## Build and test

- The mod needs Java 25. Build and test it with `./gradlew check build` (`.\gradlew.bat` on Windows) after `./scripts/fetch-libs.sh` fetches the third-party mod JARs.
- The coordinator needs Node 22. Run `npm ci` in `coordinator/`, then `npm test`.
- [DEVELOPMENT.md](DEVELOPMENT.md) explains the other Minecraft targets, the Windows package and the full verification script.

Run the checks for the part you changed before you open a pull request.

## Pull requests

- Open a pull request against `main` and fill in the template.
- The owner reviews and squash-merges every pull request. The required check is `Coordinator (Linux)`.
- CI on a pull request from a fork starts only after the owner approves the run.

## Keep private details out

The repository is public, and every push is public at once. Never put home-folder paths, account or user names, hostnames, machine names, IP addresses, email addresses, usage or billing figures, game recordings, run records, keys or tokens in a file, a commit message, a branch name or a pull request. Commit with your GitHub no-reply address.

Turn on the commit hooks once per clone. They run the same scan CI runs, on what you stage and on your commit message:

```bash
git config core.hooksPath scripts/hooks
```

[AGENTS.md](AGENTS.md#private-details-stay-off-the-repository) explains what to do when the scan flags a line.
