// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/** Public schema barrel for the codex app-server module. Always import
 * from `'./schema/index.js'`, never from `./schema/generated/<File>.js`
 * directly — that lets the regen script swap out individual files
 * without touching consumer imports. */

export * from './generated/index.js';
