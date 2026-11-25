# Changelog

## [0.1.0]

Initial public release.

- Browse, filter, and preview saved Pi conversations across projects with
  `/sessions` or Left Arrow at an empty prompt.
- Focus a registered Pi session in tmux or supported Linux Ghostty tabs without
  stopping it, or open a saved session in a new tmux window or Ghostty tab.
- Confirm before switching in place, with keeping the current session as the
  default.
- Use the full `pisessions` browser, including archive, restore, and delete,
  from either `/sessions` or Left Arrow. Management uses file recency, not the
  active-session registry; close affected sessions before archiving, deleting,
  or renaming them.
