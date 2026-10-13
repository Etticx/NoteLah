# What is NoteLah

It is a personal project intended to solve my daily problem, usually i have tons to do and i didn't jot it down. Thus,
i forgot. So this app helps track my task and give some sense of accomplishment on the profile page when we have the
box with green and greener thing. similar like token used haha.

## Use the Windows app

Open `outputs/NoteLah-0.1.0.exe`. A build copy also lives in `release/`. This is a portable Windows application; Node.js and a web server are not needed to use it. The first launch opens a blank workspace. The optional sample workspace is a temporary demonstration and never changes your own saved data.

To pin NoteLah to the Windows taskbar, keep the portable `.exe` in a permanent folder, open it, then right-click its taskbar icon and choose **Pin to taskbar**. If you pinned an older build and Windows says the executable is missing, unpin that shortcut and pin again after opening the updated build. Moving or renaming the portable `.exe` also requires pinning again.

- **Today:** add tasks, keep notes, choose dates, complete work, and bring unfinished tasks forward.
- **Later:** capture ideas without choosing a date, then schedule them when ready.
- **My profile:** edit your name and bio, see completed work, and click a day in the green activity grid to revisit it.
- **Settings:** choose the start of the week, manage backups, restore, and export.


## Develop

Requires Node.js 22.12 or newer and npm.

```sh
npm ci
npm run dev
```

Open the local URL printed by Next.js. All fonts are bundled locally.

```sh
npm run typecheck
npm test
npm run build
npm run preview
npm run desktop
npm run package:win
```

`desktop` builds the Next.js static export and opens it in Electron. `package:win` builds the portable Windows executable in `release/`. Development and packaging require downloading open-source dependencies; the packaged application runs offline.

The desktop app is intended for one person on one laptop. Cloud synchronization and native file attachments are not implemented. The Windows build is unsigned.

Open-source acknowledgments are in `THIRD_PARTY_NOTICES.md`. Dependency versions are locked in `package-lock.json`.
