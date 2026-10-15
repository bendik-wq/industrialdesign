# Data VSL funnel

Live at https://data-vsl.bendik-50e.workers.dev: the G&L data VSL, an apply form (saved to D1 `data-vsl-leads`) and a CSV export at `/admin/leads.csv` (HTTP Basic auth, password in the `ADMIN_PASSWORD` Worker secret).

The video (`public/media/data-vsl.mp4`, 17 MB) isn't in git. Put it back in `public/media/` before running `wrangler deploy`. The Worker serves `/media/*.mp4` with byte-range support so iPhones can play it.
