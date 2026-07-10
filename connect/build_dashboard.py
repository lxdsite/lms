#!/usr/bin/env python3
"""
build_dashboard.py — build/maintain the Moodle engagement *grading* tool.

The tool itself (`dashboard.html`) ingests log uploads in the browser, so this
script no longer processes data per course. It has two jobs:

    python3 build_dashboard.py                 # BUNDLE: inline src/ + vendor/ -> dashboard.html
    python3 build_dashboard.py --selftest F.json   # print reference stats for a log file

`--selftest` runs the original, frozen Python pipeline and prints JSON stats. It
is the regression oracle: src/ingest.js (the in-browser port) must reproduce these
numbers exactly. Stdlib only.
"""

import argparse
import html
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# Event taxonomy (kept in lock-step with src/ingest.js).
# ---------------------------------------------------------------------------
CATEGORIES = ["content", "quiz", "quiz_autosave", "assignment", "forum",
              "questionnaire", "checklist", "grade_check", "other"]
CAT_INDEX = {c: i for i, c in enumerate(CATEGORIES)}
ENGAGEMENT_CATS = {"content", "quiz", "assignment", "forum",
                   "questionnaire", "checklist", "grade_check", "other"}

EVENT_CATEGORY = {}
def _assign(cat, names):
    for n in names:
        EVENT_CATEGORY[n] = cat

_assign("content", [
    "Course module viewed", "Course viewed", "Chapter viewed", "Discussion viewed",
    "Zip archive of folder downloaded", "Course module instance list viewed", "Course searched"])
_assign("quiz", [
    "Quiz attempt started", "Quiz attempt updated", "Quiz attempt submitted",
    "Quiz attempt viewed", "Quiz attempt summary viewed", "Quiz attempt reviewed",
    "Quiz attempt preview started", "Attempt resumed"])
_assign("quiz_autosave", ["Quiz attempt auto-saved"])
_assign("assignment", [
    "Submission created.", "A submission has been submitted.", "A file has been uploaded.",
    "An online text has been uploaded.", "Submission updated.", "Submission removed.",
    "Submission form viewed.", "The status of the submission has been viewed.",
    "The status of the submission has been updated.", "Submission confirmation form viewed.",
    "Remove submission confirmation viewed.", "Feedback viewed"])
_assign("forum", [
    "Post created", "Post updated", "Post deleted", "Discussion created",
    "Some content has been posted", "Subscription created", "Subscription deleted",
    "Discussion subscription created", "Discussion subscription deleted"])
_assign("questionnaire", [
    "Responses submitted", "Individual Responses report viewed", "Questionnaire previewed",
    "All Responses report viewed"])
_assign("checklist", ["Checklist complete", "Checklist updated"])
_assign("grade_check", [
    "Grade user report viewed", "Grade overview report viewed",
    "User report viewed", "Course user report viewed"])

DEFINITIVE_STAFF_EVENTS = {
    "Grader report viewed", "Grading table viewed", "Grading form viewed",
    "Grade single view report viewed.", "Grade item updated", "Grade item created",
    "Grade item deleted", "Grade letter updated", "Grade letter deleted", "Grade deleted",
    "The submission has been graded.", "Question manually graded", "OpenDocument grade exported",
    "Log report viewed", "Activity report viewed", "Forum summary report viewed", "Report viewed",
    "Subscribers viewed", "Non-respondents viewed",
    "Course module created", "Course module updated", "Course module deleted",
    "Course section created", "Course section updated", "Course updated", "Course restored",
    "Calendar event created", "Calendar event updated", "Calendar event deleted",
    "Chapter updated", "Folder updated", "Edit page viewed", "Quiz edit page viewed",
    "Question created", "Question deleted", "Question category viewed", "Slot deleted",
    "Quiz override created", "Item created", "Item deleted",
    "Role assigned", "Role unassigned", "User unenrolled from course",
    "Enrolment instance created", "Insights viewed", "Teacher checks updated",
    "Submission viewed.", "All the submissions are being downloaded.", "Subscription mode updated",
}

ACTOR_ID_RE = re.compile(r"[Tt]he user with id '(-?\d+)'")


def flatten(raw):
    if isinstance(raw, list) and len(raw) == 1 and isinstance(raw[0], list):
        return raw[0]
    if isinstance(raw, list) and raw and isinstance(raw[0], list):
        out = []
        for sub in raw:
            out.extend(sub)
        return out
    return raw


def parse_time(s):
    s = (s or "").strip()
    for fmt in ("%d/%m/%y, %H:%M:%S", "%d/%m/%Y, %H:%M:%S", "%d/%m/%y, %H:%M"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def actor_id(desc):
    m = ACTOR_ID_RE.search(desc or "")
    return m.group(1) if m else None


def parse_context(ctx):
    ctx = html.unescape(ctx or "").strip()
    if ": " in ctx:
        t, name = ctx.split(": ", 1)
        return t.strip(), name.strip()
    return "Other", ctx


# ---------------------------------------------------------------------------
# Frozen reference pipeline (regression oracle for src/ingest.js)
# ---------------------------------------------------------------------------
def process(logs_path):
    with open(logs_path, encoding="utf-8") as f:
        records = flatten(json.load(f))
    n_total = len(records)

    name_by_id = defaultdict(Counter)
    total_by_id = Counter()
    staff_signal_by_id = Counter()
    impersonator_names = set()
    activities = {}
    tmin = tmax = None

    def activity_idx(key):
        if key not in activities:
            activities[key] = len(activities)
        return activities[key]

    parsed = []
    for r in records:
        ev = r.get("eventname", "")
        actor = r.get("userfullname", "") or ""
        dt = parse_time(r.get("time", ""))
        if dt:
            tmin = dt if tmin is None else min(tmin, dt)
            tmax = dt if tmax is None else max(tmax, dt)
        impersonated = " as " in actor
        if impersonated:
            impersonator_names.add(actor.split(" as ", 1)[0].strip())
        aid = actor_id(r.get("description", ""))
        ctx_type, ctx_name = parse_context(r.get("eventcontext", ""))
        aidx = activity_idx((ctx_type, ctx_name))
        if aid and aid != "-1" and not impersonated:
            name_by_id[aid][actor] += 1
            total_by_id[aid] += 1
            if ev in DEFINITIVE_STAFF_EVENTS:
                staff_signal_by_id[aid] += 1
        parsed.append((dt, aid, impersonated, ev, aidx, ctx_type))

    users = {}
    for aid, namectr in name_by_id.items():
        name = namectr.most_common(1)[0][0]
        sig = staff_signal_by_id[aid]
        is_staff = sig > 0 or name == "Admin User" or name in impersonator_names
        users[aid] = {"name": name, "role": "staff" if is_staff else "student", "sig": sig}

    student_ids = {a for a, u in users.items() if u["role"] == "student"}
    staff_ids = {a for a, u in users.items() if u["role"] == "staff"}

    day_set = set()
    if tmin and tmax:
        cur = tmin.date()
        while cur <= tmax.date():
            day_set.add(cur)
            cur = cur.fromordinal(cur.toordinal() + 1)

    cat_counts = Counter()
    student_events = 0
    for (dt, aid, impersonated, ev, aidx, ctx_type) in parsed:
        if impersonated or aid not in student_ids or dt is None:
            continue
        student_events += 1
        cat_counts[EVENT_CATEGORY.get(ev, "other")] += 1

    stats = {
        "totalRecords": n_total,
        "students": len(student_ids),
        "staff": len(staff_ids),
        "studentEvents": student_events,
        "engagementEvents": sum(cat_counts[c] for c in ENGAGEMENT_CATS),
        "activities": len(activities),
        "days": len(day_set),
        "categoryCounts": {c: cat_counts[c] for c in CATEGORIES},
        "staffNames": sorted(users[a]["name"] for a in staff_ids),
    }
    return stats


def selftest(logs_path):
    print(json.dumps(process(logs_path), indent=2, ensure_ascii=False))


# ---------------------------------------------------------------------------
# Bundler: inline src/ + vendor/ into the standalone, no-data tool
# ---------------------------------------------------------------------------
def read(path):
    with open(os.path.join(HERE, path), encoding="utf-8") as f:
        return f.read()


def bundle():
    out = read("src/template.html")
    out = out.replace("/*{{STYLES}}*/", read("src/styles.css"))
    out = out.replace("/*{{CHARTJS}}*/", read("vendor/chart.umd.min.js"))
    out = out.replace("/*{{INGEST}}*/", read("src/ingest.js"))
    out = out.replace("/*{{APP}}*/", read("src/app.js"))
    out_path = os.path.join(HERE, "dashboard.html")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(out)
    size = os.path.getsize(out_path) / 1024
    print(f"Bundled -> {out_path}  ({size:.0f} KB)")
    print("Open it in a browser and upload a Moodle Logs JSON export.")


def main():
    ap = argparse.ArgumentParser(description="Bundle the engagement grading tool, or run the regression oracle.")
    ap.add_argument("--selftest", metavar="LOGS.json", help="Print reference stats for a log file (regression oracle).")
    args = ap.parse_args()
    if args.selftest:
        if not os.path.exists(args.selftest):
            sys.exit(f"File not found: {args.selftest}")
        selftest(args.selftest)
    else:
        bundle()


if __name__ == "__main__":
    main()
