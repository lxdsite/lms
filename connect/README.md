# Moodle Time-on-Course Dashboard

A single, self-contained web page that turns a Moodle **Logs** export into a
**reference of how much time each student spent** — on the course overall and on
each activity. You upload a course's log file in the browser; all processing
happens locally (the data never leaves your computer). It's a reference to look
at while you assign scores manually in Moodle. Works offline; reusable for any course.

---

## Using it

1. Open **`dashboard.html`** in any browser (double-click it).
2. **Drag in** (or click to choose) a Moodle Logs JSON export — `logs_*.json`.
3. On the **Time** tab:
   - **By student** — each student's estimated time on course, sessions, active
     days, activities opened, last seen. Click a student for their time **per
     activity** and **per type**, plus a timeline.
   - **By activity** — time spent on each activity (and a by-type roll-up), with
     average per student.
   - **Download time (CSV)** for a per-student summary (total + per-type minutes)
     to keep beside your gradebook.

Use **Load course…** to switch to another course's log; settings and role
corrections are remembered per course.

### Exporting the log from Moodle
In the course: **Reports → Logs**, keep "All participants" / "All days", set the
**Download** format to **JSON**, and download.

---

## How "time spent" is estimated — important

Moodle logs record timestamped **clicks**, not durations, so time is **estimated**
(the same method as Moodle's "Dedication" block):

- A student's clicks are grouped into **sessions**; a gap longer than the
  **session gap** (default **60 min**, adjustable on the Time tab) ends a session.
- Time = the spans within sessions. Each gap between two clicks is credited to the
  activity of the earlier click, so **per-activity time adds up to the total**.
- It **cannot** measure reading time after the *last* click in a session, and a
  lone click counts as ~0. So treat the numbers as a **relative reference**, not
  exact minutes. A larger session gap gives larger (more generous) totals.

### Other tabs (context)
**At-risk** (low-activity early warning), **Engagement over time** (daily trend,
day×hour heatmap), **Content** (most/least-opened activities), and
**Assessment & participation** (submissions, quizzes, forums).

### Roles
Students vs. staff are auto-detected from behaviour (grading, report-viewing,
course editing, logging in *as* a student) and staff are excluded. Click **Manage
roles** to review/override; saved per course.

---

## For maintainers

End users never run Python. The tool is bundled from `src/` + `vendor/`:

```bash
python3 build_dashboard.py            # bundle -> dashboard.html (no data)
python3 build_dashboard.py --selftest logs_FINC-S-0030_20260630-1518.json   # reference stats
```

```
build_dashboard.py   # bundler + frozen reference pipeline (--selftest oracle)
src/
  ingest.js          # parse a logs export -> in-memory model (runs in browser AND Node)
  app.js             # time estimation (sessionization), Time tab, charts, role editor, CSV
  styles.css         # appearance + print/PDF layout
  template.html      # page skeleton (upload screen, tabs, modals)
vendor/chart.umd.min.js   # charts, inlined at bundle time
dashboard.html       # generated output — the tool you open
```

`src/ingest.js` is a port of the frozen Python pipeline and must agree with it —
`--selftest` prints the reference numbers (students, staff, event counts) to check
against. The session-gap default and event taxonomy live near the top of
`src/app.js` / `src/ingest.js`. Per-student total time always equals the sum of its
per-activity times by construction.
