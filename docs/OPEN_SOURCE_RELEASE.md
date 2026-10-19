# Before making a public release

These checks reduce risk; they are not a legal clearance or a guarantee against claims. Record what was checked for each release. University, employment, sponsorship, collaborator, trademark, patent, and jurisdiction-specific questions require separate review where applicable.

## Rights and identity

- Confirm you can release the source, artwork, icons, fonts, examples, and contributions. Check university and sponsor agreements before releasing a degree project.
- Confirm the copyright attribution in `LICENSE` accurately identifies the rights holders; the current collective attribution is "NoteLah contributors".
- Check the NoteLah name for conflicting uses and relevant trademarks before wider distribution. No trademark clearance has been performed by adding these files.
- Keep third-party licences separate from the MIT licence covering NoteLah's original code. Do not claim third-party projects endorse this application.

## Private information and repository history

- Inspect `git ls-files`, the staged diff, and all refs/history intended for publication. Run a reputable secret scanner over that history. The ignore file prevents some future additions; it does not erase earlier commits or files added with force.
- Exclude actual databases, backups, imported documents, real resumes, private screenshots, chat/debug traces, environment files, credentials, and model caches. Review issues, release attachments, and build logs too.
- If a secret was exposed, revoke or rotate it first. Removing a file from the latest commit does not revoke a secret or remove historical copies.
- Use synthetic demonstrations. Check whether documents contain other people's contact details before publishing examples.

## Licences and packaging

- Run `npm ci` then `npm run licenses:generate`. Inspect the generated `THIRD_PARTY_LICENSES.txt`, including declared licences and entries without collected licence text. Investigate missing notices or unexpected restrictive terms before release.
- The generator collects installed dependency notices, including development tools, and selected bundled assets. It is a collection aid, not a legal compatibility engine. Reassess its coverage when packages change.
- Run `npm run package:win`. The packaging hook regenerates licence texts. Inspect the actual artifact to confirm `LICENSE`, `THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_LICENSES.txt`, `PRIVACY.md`, and `DISCLAIMER.md` are included, alongside Electron's upstream licence files.
- Models and Ollama are separate installations, not included in the current executable. Link users to official downloads and relevant licences. If distributing weights later, verify the exact model/tag and quantization distributor's terms and include required licences and notices. Do not assume all models share Qwen's licence.
- Review direct, transitive, and embedded dependencies and their security advisories. Generating notices does not certify compatibility or security.

## Behavior and release evidence

- Run type checking, automated tests, a production build, and appropriate isolated packaged smoke checks. Never restore test data into a real workspace.
- Verify backups and upgrades on isolated fixtures. Record known issues and actual model/hardware requirements.
- Ensure privacy documentation matches actual network requests, logging, persistence, deletion, and future agent memory/action behavior.
- Document that AI answers can be wrong. Preserve user review of proposed changes when implementing agents.
- Publish only intended artifacts, record their SHA-256 hashes, and identify unsigned builds accurately. Do not advertise legal immunity, guaranteed accuracy, guaranteed privacy against all software, or guaranteed protection from data loss.
