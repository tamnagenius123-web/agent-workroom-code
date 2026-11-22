# WR-GIT disabled

`WRGIT_ENABLED` stays `"0"` in the product config and in the scratch copy. The scratch copy also drops the `artifacts` binding.

`POST /git/merge` returns 503 `AUTH_NOT_CONFIGURED` because authentication runs before `gitRoute`. The flag-off 404 inside `gitRoute` is covered by the unit tests, not by this drive.
