// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
if('serviceWorker' in navigator) navigator.serviceWorker.register('/dev-sw.js?dev-sw', { scope: '/', type: 'module' })