# Pairs competition in XertOS

Byron runs the Pairs comp (Saturday 19 December 2026) from the XertOS app as
well as from the XERT admin, and members can enter from XertOS as well as at
xertfitness.com.au/pairs. XERT stays in charge: every entry is a response to
XERT's Pairs form, so the admin board, /pairs and XertOS always show the same
list. XertOS reads and writes it over the signed XertOS webhook.

Migration `20261128020000_xertos_pairs.sql` adds the database side. It only
touches a form tagged `pairs`, and only the service key can call it.

## Switching it on

Once XertOS has its Pairs screens, set `CLIENT0_PAIRS_ENABLED=true` in Vercel
next to `CLIENT0_SYNC_ENABLED=true`, then redeploy. Until then every Pairs
action answers 501 `ACTION_NOT_READY` and nothing reaches the database. To
switch it off again, remove the variable and redeploy.

## The endpoint

`POST https://xertfitness.com.au/api/xertos-webhook`, signed exactly like
`book` and `passSale`: `x-webhook-timestamp` (unix seconds, within 5 minutes)
and `x-webhook-signature: v1,k<version>=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`
with the write secret, plus `x-xertos-site: xert_fitness`.

Success is `200 { ok: true, ... }`. A refusal is
`{ error: { code, message } }`, where `message` is written for the person on
the screen.

### `pairsBoard`: read the comp

```json
{ "action": "pairsBoard" }
```

```json
{
  "ok": true,
  "competition": {
    "slug": "pairs-2026-11-19",
    "title": "…", "description": "…",
    "eventDate": "2026-12-19", "eventLabel": "19.12.2026",
    "entriesCloseAt": "2026-12-19T14:00:00.000Z",
    "entriesOpen": true,
    "entriesSwitchedOff": false,
    "form": { "id": "uuid", "updatedAt": "…", "questions": [ … ] },
    "divisions": {
      "categoryQuestionId": "pairs-category",
      "categories": ["Everyday", "Intermediate", "Advanced"],
      "splitQuestionId": "aacdf9ca-…", "splitLabel": "SUB category",
      "splitOptions": ["MALE/MALE", "FEMALE/FEMALE"]
    },
    "entries": [
      { "id": "uuid", "name": "…", "email": "…", "phone": null,
        "enteredAt": "…", "archivedAt": null, "answers": { "<question id>": "…" } }
    ]
  }
}
```

- `form.questions` is the form as Byron set it up in Forms & surveys: ids,
  types, wording, options, required and hidden. Build the entry screen from
  it. Do not hard-code the questions, because he adds and changes them.
- A division is a category × a split option. An entry whose answers do not
  fit a known category or split still belongs on the board, in a "not set"
  group.
- Entries with `archivedAt` set have been removed. Show them only in a
  "Removed" list that can be restored from.

### `pairsEnter`: a member enters

```json
{ "action": "pairsEnter",
  "entry": { "email": "member@example.com", "name": "…", "phone": "…",
             "answers": { "<question id>": "<answer>" } } }
```

Answers `{ ok: true, entryId }`. The entry is recorded against the XERT
account with that email, so /pairs shows that member as entered too. It goes
through the same checks as /pairs: required questions, choices from the
list, and one entry per email.

| code | status | when |
| --- | --- | --- |
| `ENTRIES_CLOSED` | 422 | after `entriesCloseAt`, or entries switched off |
| `NO_XERT_ACCOUNT` | 422 | no XERT account has this email |
| `XERT_ACCOUNT_AMBIGUOUS` | 422 | more than one XERT account has it |
| `ALREADY_ENTERED` | 409 | this email already has a pair in |
| `INVALID_ENTRY` | 422 | a required answer is missing, or a choice is not on the list |
| `FORM_CHANGED` | 409 | the form changed during the request. Re-read and retry |
| `PAIRS_NOT_FOUND` | 404 | there is no Pairs form open |

### `pairsSetArchived`: remove or restore an entry

```json
{ "action": "pairsSetArchived", "entryId": "uuid", "archived": true }
```

Answers `{ ok: true, entryId, archivedAt }`. Removing archives the entry and
never deletes it, the same as Remove entry on the XERT admin board. The
person can then enter again. Restoring is refused with `ALREADY_ENTERED`
while the same email has another entry in. An unknown id answers 404
`ENTRY_NOT_FOUND`.

## Not covered by this

The forms sync still copies each new response to XertOS once. An entry made
through `pairsEnter` comes back that way too, under the same `entryId`, so
XertOS should treat it as the same entry. Heats, check-in and scoring are not
here yet. They wait on Byron's answers about how the comp runs.
