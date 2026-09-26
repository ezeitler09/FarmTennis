# Farm Tennis Ladder

Standings, weekly schedule and self-reported scores for the Farm Tennis men's singles ladder.

- **Website:** plain HTML, CSS and JavaScript (no build step), hosted on Vercel.
- **Database and sign-in:** Supabase project `FarmTennis` (`ekrbwnalxpjcdnzsoiqg`).

## How it works

- Anyone with the link can see standings, the schedule and results.
- Players sign in with a one-time email link. Only emails on the roster can sign in.
- A signed-in player can report or correct the score of **their own** matches. League admins can edit any match.
- Email addresses are shown only to signed-in players.
- Every score change is recorded in `match_history` with who made it and when.
- Standings come from the `standings` view in the database.

All writes go through two database functions, `report_result` and `clear_result`, which check who is signed in. The tables have row-level security turned on and no insert/update/delete policies, so the website's public key can't change data any other way.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The website |
| `config.js` | Supabase URL and publishable key (safe to be public) |
| `supabase/migrations/` | Database schema, security rules and functions |
| `supabase/seed.sql` | Fall 2026 roster, schedule and results imported from the original Google Doc |

## One-time setup in Supabase

1. **Email sender.** Supabase's built-in sender only mails members of your Supabase team, so connect your own:
   Supabase dashboard → Authentication → Emails → SMTP Settings. For Gmail: host `smtp.gmail.com`, port `587`, username = your Gmail address, password = a Gmail [app password](https://myaccount.google.com/apppasswords) (requires 2-step verification). Sender name: `Farm Tennis Ladder`.
2. **Site address.** Authentication → URL Configuration → Site URL = the Vercel address, and add the same address under Redirect URLs.

## Common admin tasks (SQL editor in Supabase)

Add a league admin (for example, the pro):

```sql
insert into public.admins (email) values (lower('pro@example.com'));
```

Change a player's email:

```sql
update public.player_emails set email = lower('new@example.com') where player_id = 'andrew-kay';
```

See the change log for a match:

```sql
select changed_at, changed_by, summary from public.match_history where match_id = 'w3-13' order by changed_at;
```

Update the playoffs line:

```sql
update public.season set playoffs = 'Top 8, starting Oct 24' where id = 1;
```
