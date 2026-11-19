# Contributing

Thanks for helping. A few rules keep the parts swappable and the build safe.

## How work is shaped

- **Build to the contract.** Each part has a contract in `contracts/`: inputs, outputs, error codes and a fixture. Build against that, not against another part's internals.
- **Contracts change by a dated edit,** proposed in a pull request and approved by a maintainer. Don't change a contract inside a feature PR.
- **Done means green against the fixtures.** The end-to-end fixture errand must still pass.
- **Record the cost.** Each PR notes lines added, dependencies added and hours spent, in `measure.md`.

## House rules

- **No secrets, ever:** not in code, config, environment files, logs, test output, screenshots or issues. A part that needs a secret gets it through the broker's `CredentialStore` seam. Fixtures use obviously fake values.
- **Local by default.** A part listens on a Unix socket or loopback. Nothing listens on a public interface.
- **One process per part,** run as its own user under a systemd user unit (`UMask=0077`).
- **Pin versions** and record checksums for anything downloaded.
- **Honest automation.** No stealth or anti-detection techniques, no faked user agents, no human impersonation. If a site blocks honest automation, write it down as a finding.
- **Plain markdown docs.**

## Getting started

1. Pick a part whose README says it's open, or an issue labelled `help wanted`.
2. Read its contract and the fixtures it depends on.
3. Open a draft PR early.
