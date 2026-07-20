# Changelog

All notable changes to Orbital. Generated automatically from Conventional Commits — do not edit by hand.

## [1.14.1](https://github.com/jimbuck/orbital/compare/v1.14.0...v1.14.1) (2026-07-20)


### Bug Fixes

* use regular dash instead of emdash in window title ([10273a5](https://github.com/jimbuck/orbital/commit/10273a52d34d4fc82175ef07da0a69d6001f1f53))

# [1.14.0](https://github.com/jimbuck/orbital/compare/v1.13.3...v1.14.0) (2026-07-20)


### Features

* edit workspace name in Settings ([#7](https://github.com/jimbuck/orbital/issues/7)) ([bb64e2a](https://github.com/jimbuck/orbital/commit/bb64e2a88bdf3847b5d71edc564b7df9c834b055))
* include workspace name in the OS window title ([#8](https://github.com/jimbuck/orbital/issues/8)) ([ded7a91](https://github.com/jimbuck/orbital/commit/ded7a9142efadb6cd828693fdfdba2755670573c))

## [1.13.3](https://github.com/jimbuck/orbital/compare/v1.13.2...v1.13.3) (2026-07-20)


### Bug Fixes

* modals no longer close on outside click or drag-release ([#6](https://github.com/jimbuck/orbital/issues/6)) ([1db6503](https://github.com/jimbuck/orbital/commit/1db650338ff0e75d601355e14e692ae4b2a9dfcc))

## [1.13.2](https://github.com/jimbuck/orbital/compare/v1.13.1...v1.13.2) (2026-07-17)


### Bug Fixes

* background worktree node_modules copy and show a setting-up indicator ([bda2e18](https://github.com/jimbuck/orbital/commit/bda2e18021f89297b7b719e14d4bd7e2ea4f64f8))

## [1.13.1](https://github.com/jimbuck/orbital/compare/v1.13.0...v1.13.1) (2026-07-10)


### Bug Fixes

* show filename not full path in git changed-files tree ([4e1e5a6](https://github.com/jimbuck/orbital/commit/4e1e5a615436e30a69fa1fd27e0f33daa112b3af))

# [1.13.0](https://github.com/jimbuck/orbital/compare/v1.12.1...v1.13.0) (2026-07-10)


### Features

* mouse copy/paste and a focus-aware Edit menu for terminals ([0aa91ef](https://github.com/jimbuck/orbital/commit/0aa91ef5fb250f65447ef44c07b9fef93540e9fd))

## [1.12.1](https://github.com/jimbuck/orbital/compare/v1.12.0...v1.12.1) (2026-07-09)


### Bug Fixes

* report Orbital as the Windows exe FileDescription ([0382d83](https://github.com/jimbuck/orbital/commit/0382d8358df88698936cf9689cad41189ef7ab90))

# [1.12.0](https://github.com/jimbuck/orbital/compare/v1.11.0...v1.12.0) (2026-07-09)


### Bug Fixes

* make worktree-backed flight deletion reliable on Windows ([977f9e1](https://github.com/jimbuck/orbital/commit/977f9e1d854b3daa700837d5999e26c17689ede3))


### Features

* add Cursor CLI agent + per-agent visibility toggles ([47d2eef](https://github.com/jimbuck/orbital/commit/47d2eeff4f11ab5f79203eb9a455dc8072f34958))
* clean up the kanban board ([8418259](https://github.com/jimbuck/orbital/commit/84182596f8fc6dd61d6fda6fd83cbe38b73c932d))
* internal/external link handling for terminal, editor, and browser ([b7682a4](https://github.com/jimbuck/orbital/commit/b7682a4fa0c9e86324cddc3a56c044e055de2f6f))
* light/dark/system theme toggle ([5cd516f](https://github.com/jimbuck/orbital/commit/5cd516f4e674217fecb219aa3fc0cb6c3198bc62))
* markdown editor with write/preview toggle for task descriptions ([09e6e2c](https://github.com/jimbuck/orbital/commit/09e6e2c2963c8a1f03d362c5ee4d60e8241fff6f))
* opt-in rotating debug logging ([1edecdc](https://github.com/jimbuck/orbital/commit/1edecdc47f72fa23f8b1e54a02eb9e19e881faf1))
* periodic background git fetch (toggleable, on by default) ([e9271b4](https://github.com/jimbuck/orbital/commit/e9271b47d97dca94d19d1a326c1282d69ffda295))
* render git changes as a collapsible tree ([b723adf](https://github.com/jimbuck/orbital/commit/b723adf23dce73e8c93dc1bb8dff9945b2465239))
* suggest recently-used tags when editing task tags ([32bf669](https://github.com/jimbuck/orbital/commit/32bf6698b6536fed911e5d6805bf91ddbf054fdf))

# [1.11.0](https://github.com/jimbuck/orbital/compare/v1.10.0...v1.11.0) (2026-07-08)


### Features

* add Draft task status ([6109788](https://github.com/jimbuck/orbital/commit/6109788f1109bd492ab2956998a39629c3bf9889))

# [1.10.0](https://github.com/jimbuck/orbital/compare/v1.9.1...v1.10.0) (2026-07-08)


### Features

* use official Claude and OpenAI brand marks for agent icons ([8951a29](https://github.com/jimbuck/orbital/commit/8951a29b6a02ec5da00c265f9aa81908c8d9f7d3))

## [1.9.1](https://github.com/jimbuck/orbital/compare/v1.9.0...v1.9.1) (2026-07-08)


### Bug Fixes

* spawn terminal PTY at the renderer-reported size to avoid jumbled agent startup ([caee2d5](https://github.com/jimbuck/orbital/commit/caee2d53e4161c887e5dde7b08dc20b565bdc9d7))

# [1.9.0](https://github.com/jimbuck/orbital/compare/v1.8.2...v1.9.0) (2026-07-08)


### Features

* task card right-click menu; enlarge the Edit Task modal ([74cecca](https://github.com/jimbuck/orbital/commit/74ceccacb09ca18da70f4337992a37173ccce400))

## [1.8.2](https://github.com/jimbuck/orbital/compare/v1.8.1...v1.8.2) (2026-07-08)


### Bug Fixes

* restore Open in Explorer/Terminal actions on the workspace row menu ([482c701](https://github.com/jimbuck/orbital/commit/482c7014c04afce7eae923202c590d99cb39a83c))

## [1.8.1](https://github.com/jimbuck/orbital/compare/v1.8.0...v1.8.1) (2026-07-08)


### Bug Fixes

* replace per-directory chokidar watchers with native recursive fs.watch ([3456a3e](https://github.com/jimbuck/orbital/commit/3456a3e3b29674b98ccfb60a8ca29edff46e5c6d))

# [1.8.0](https://github.com/jimbuck/orbital/compare/v1.7.0...v1.8.0) (2026-07-08)


### Features

* codex provider, FIFO tasks, flight menu actions, live file tree, recursive env sync ([3f81997](https://github.com/jimbuck/orbital/commit/3f8199735d6d167b5a09b568c3b80b944284b64e))

# [1.7.0](https://github.com/jimbuck/orbital/compare/v1.6.0...v1.7.0) (2026-07-08)


### Bug Fixes

* typing at an idle prompt resets needs-attention to idle, not working ([7337483](https://github.com/jimbuck/orbital/commit/733748325888209f0b62dc785eb4c6321c60e78c))


### Features

* paste clipboard images into terminals as scratch-file paths ([139a180](https://github.com/jimbuck/orbital/commit/139a180f612cabda60e0658609e27c83490b2ea0))
* workspace header row is the root Flight; chevron only with worktrees ([b103b39](https://github.com/jimbuck/orbital/commit/b103b39dd4e495fdf866c6f937c2a7c04b2727dc))

# [1.6.0](https://github.com/jimbuck/orbital/compare/v1.5.0...v1.6.0) (2026-07-07)


### Bug Fixes

* drop stale hook status events so an idle flight can't spin forever ([f871bde](https://github.com/jimbuck/orbital/commit/f871bdeb195963e2a2d662ea11ce97d9bfb375a7))
* key editor tabs by id so a new diff tab shows the clicked file ([80d3e77](https://github.com/jimbuck/orbital/commit/80d3e7761d66e24ba1be74f2491e31826d61075c))
* release worktree locks before deleting a Flight ([ef1bc54](https://github.com/jimbuck/orbital/commit/ef1bc547cbd18e076b4688486dd493d9ec7e4465))


### Features

* 'Clear Status' flight menu item force-resets a stuck status ([1f67a8e](https://github.com/jimbuck/orbital/commit/1f67a8e50e81f91a173246771af1c21434f69415))
* edit tasks in a modal, cards become display-only ([90f3c06](https://github.com/jimbuck/orbital/commit/90f3c06d9081eba70ae8d0d9535c8c5061278e94))
* new Flights start with an empty pane instead of an auto-opened terminal ([7725f29](https://github.com/jimbuck/orbital/commit/7725f29cd56951b1df1539e96c9a86065c991ee6))
* switch or create branches from the git panel (root flight only) ([465ed04](https://github.com/jimbuck/orbital/commit/465ed04ca777a8ad25557dae2058b46aee2f164f))
* task panel is always a list; expand opens the kanban ([50a99db](https://github.com/jimbuck/orbital/commit/50a99dbca0cd88fdf6316bf9b076f496b89556d2))

# [1.5.0](https://github.com/jimbuck/orbital/compare/v1.4.0...v1.5.0) (2026-07-07)


### Bug Fixes

* give all enabled buttons a pointer cursor ([483e9b4](https://github.com/jimbuck/orbital/commit/483e9b46e6e636a681f0bb7baa41fdc2c286c05a))
* give the right-panel task list its own scroll region ([665feac](https://github.com/jimbuck/orbital/commit/665feac9ac4a76cc8d65109dd0f40666078954ea))
* keep the titlebar bottom border continuous under menus and window controls ([4d6adf1](https://github.com/jimbuck/orbital/commit/4d6adf180545f57dd1b3de831f2451857e36a42d))


### Features

* allow workspaces to be renamed from the rail context menu ([1c388e4](https://github.com/jimbuck/orbital/commit/1c388e4a1afa61321482d662f0f098ed7d63c675))
* **cli:** add task show and task delete, list tags in task list ([5fb25c0](https://github.com/jimbuck/orbital/commit/5fb25c072324a3424498ed35c4c463d7d1c76469))
* default env sync covers agent config dirs and node_modules ([04b3048](https://github.com/jimbuck/orbital/commit/04b3048be92432ca3081472bf334e820b285e700))
* expand tasks with tags plus editable descriptions in the panel ([f0b9475](https://github.com/jimbuck/orbital/commit/f0b9475ed4e76aaaa0d5028d12c81cb9568f3a5d))
* hover-revealed Add Task placeholder in board columns ([03e9544](https://github.com/jimbuck/orbital/commit/03e95440d9ba60756fa020df912ed83095d1c36c))
* right-click context menu on tabs (rename, split, close, close others) ([8cc5d6d](https://github.com/jimbuck/orbital/commit/8cc5d6dc85b24b7cc5fdeb258ac5243af2f4635b))
* syntax highlighting while editing in the editor tab ([7fb960b](https://github.com/jimbuck/orbital/commit/7fb960b2ab0c9fa821ed2c7d6c00da6d00f554ba))

# [1.4.0](https://github.com/jimbuck/orbital/compare/v1.3.1...v1.4.0) (2026-07-07)


### Bug Fixes

* resync flight branch names after external checkouts ([fd3e3f7](https://github.com/jimbuck/orbital/commit/fd3e3f74f4920aefa5c9d0ef34f3acf380616833))


### Features

* draggable resize for the workspace rail and right panel ([13a2d6f](https://github.com/jimbuck/orbital/commit/13a2d6fb43779cbdf96d0eafe59dd6a65e644d73))

## [1.3.1](https://github.com/jimbuck/orbital/compare/v1.3.0...v1.3.1) (2026-07-07)


### Bug Fixes

* allow WebAssembly in renderer CSP so shiki syntax highlighting works ([0c13075](https://github.com/jimbuck/orbital/commit/0c1307556fd7a6a4925f64eae684351686bb7f81))

# [1.3.0](https://github.com/jimbuck/orbital/compare/v1.2.2...v1.3.0) (2026-07-07)


### Features

* satellite in the app icon is now the taskbar alert badge ([#4](https://github.com/jimbuck/orbital/issues/4)) ([c078411](https://github.com/jimbuck/orbital/commit/c0784118b310658cb97fd888462302ca583d52d9))

## [1.2.2](https://github.com/jimbuck/orbital/compare/v1.2.1...v1.2.2) (2026-07-06)


### Bug Fixes

* stop rebuilding node-pty at package time (hangs CI) ([7098b5b](https://github.com/jimbuck/orbital/commit/7098b5b9d8a67b349107f3f6136b8535e079bcba))

## [1.2.1](https://github.com/jimbuck/orbital/compare/v1.2.0...v1.2.1) (2026-07-06)


### Bug Fixes

* override node-gyp to v11 so CI can rebuild node-pty ([941b72c](https://github.com/jimbuck/orbital/commit/941b72c6a967be0f61df1755e07b09de0b7a3ae6))

## [1.2.0](https://github.com/jimbuck/orbital/compare/v1.1.0...v1.2.0) (2026-07-06)


### Features

* agent task workflow and live dev-server registry ([08899ed](https://github.com/jimbuck/orbital/commit/08899ed182f4a25d14af97e9f06687a1e9f8495a))
* background auto-update, release tooling, and performance overhaul ([68e407c](https://github.com/jimbuck/orbital/commit/68e407c8ec363bea80f37a7e1716ad958e48ba93))
* editor image rendering and syntax-highlighted diffs ([8adc7f3](https://github.com/jimbuck/orbital/commit/8adc7f36fc2cd53d02d46c5ffa7b12d3835d2179))
* remove-workspace and delete-task affordances, README overhaul ([2e2c4aa](https://github.com/jimbuck/orbital/commit/2e2c4aaa4ca0a0c3ebdf1e26391628cbf68010a9))


### Bug Fixes

* use dedicated token for release-please PRs ([2bcc6d7](https://github.com/jimbuck/orbital/commit/2bcc6d7b43fcf34cf303095d9d8aa226af5285fd))
