---
title: Data Retention and Deletion Policy
summary: How long Lima keeps what, where, and how to delete it.
---
Lima's data lives only on your Mac and stays until you delete it. We hold no copy of your data on any server.

| Data | Where | Kept | How it's deleted |
| --- | --- | --- | --- |
| Notes, chats, workspaces, Companion memory, personal details | Encrypted store on your Mac | Until you delete them | Delete them in Lima; trashed notes stay restorable until you empty them from the trash |
| Recorded activity (for reports and Companion memory) | Encrypted store on your Mac | 90 days | Removed automatically; private windows are never recorded |
| Previous app version (for rollback) | Your Mac, in Lima's update folder | Until the next update | Replaced at the next update |
| Logs (runtime.log, update.log) | ~/Library/Logs/Lima | Until you delete them | Delete the files |
| Data held by your AI provider, search engine, Google or websites | Their systems | Under their own policies | Through each provider |

## Removing everything
Delete Lima.app, ~/Library/Application Support/Lima, ~/Library/Application Support/Lima Browser and ~/Library/Logs/Lima, then remove Lima's item from your Keychain. Lima doesn't hold a copy anywhere else.

## Legal holds
If the law requires us to keep any record longer, we keep only what's required, for as long as it's required.
