/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

let started = false;

export function startLima() {
  if (started) return;
  started = true;
  const defaults = Services.prefs.getDefaultBranch("");
  const set = (name, value) => {
    if (typeof value === "boolean") defaults.setBoolPref(name, value);
    else if (typeof value === "string") defaults.setStringPref(name, value);
    else defaults.setIntPref(name, value);
  };
  const defaultPref = set;
  const lockPref = (name, value) => {
    set(name, value);
    Services.prefs.lockPref(name);
  };

