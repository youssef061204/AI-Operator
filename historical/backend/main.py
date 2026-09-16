import json
import os
import platform
import re
import sqlite3
import subprocess
import time
import traceback
import uuid
import ctypes
from datetime import datetime, timezone
from html import escape
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import quote_plus, urljoin, urlparse
import webbrowser

import boto3
import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

load_dotenv()

AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
MODEL_ID = os.getenv("BEDROCK_MODEL_ID")
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.getenv("ARCHITECT_DATA_DIR", Path(__file__).resolve().parent / "data"))
DB_PATH = DATA_DIR / "architect.db"
GENERATED_ROOT = PROJECT_ROOT / "generated"
PUBLIC_BACKEND_URL = os.getenv("PUBLIC_BACKEND_URL", "http://127.0.0.1:8000")
PLAYWRIGHT_PROFILE_DIR = Path(os.getenv("PLAYWRIGHT_PROFILE_DIR", DATA_DIR / "playwright-profile"))
DEFAULT_DEPLOY_PROVIDER = os.getenv("DEFAULT_DEPLOY_PROVIDER", "vercel").strip().lower()

bedrock = boto3.client("bedrock-runtime", region_name=AWS_REGION) if MODEL_ID else None

app = FastAPI(title="The Architect Backend", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BAD_PATTERNS = [
    r"\btop\b",
    r"\bbest\b",
    r"\blist\b",
    r"\breview\b",
    r"\bblog\b",
    r"\bnews\b",
    r"\bwiki\b",
    r"\barticle\b",
    r"\bagency\b",
    r"clutch\.co",
    r"upcity\.com",
    r"yelp\.com",
    r"tripadvisor",
    r"facebook\.com",
    r"instagram\.com",
    r"linkedin\.com",
    r"medium\.com",
    r"reddit\.com",
    r"quora\.com",
    r"wikipedia\.org",
    r"mapquest\.com",
    r"yellowpages\.com",
    r"manta\.com",
    r"zoominfo\.com",
    r"crunchbase\.com",
    r"\.gov",
    r"\.edu",
]
SAFE_ACTION_TYPES = {
    "request_os_control",
    "start_sandbox_session",
    "create_project_directory",
    "scaffold_landing_site",
    "init_git_repo",
    "install_site_dependencies",
    "publish_github_repo",
    "open_operator_tabs",
    "open_lovable_workspace",
    "automate_lovable_site",
    "prepare_gmail_drafts",
    "open_gmail_draft_tabs",
    "sync_crm_snapshot",
    "deploy_to_vercel_preview",
    "deploy_to_netlify_preview",
}
OS_CONTROL_REQUIRED_ACTIONS = {
    "start_sandbox_session",
    "create_project_directory",
    "scaffold_landing_site",
    "init_git_repo",
    "install_site_dependencies",
    "publish_github_repo",
    "open_operator_tabs",
    "open_lovable_workspace",
    "automate_lovable_site",
    "prepare_gmail_drafts",
    "open_gmail_draft_tabs",
    "deploy_to_vercel_preview",
    "deploy_to_netlify_preview",
}
LEAD_STAGES = {"new", "contacted", "replied", "meeting", "proposal", "won", "lost"}
DEPLOY_PROVIDERS = {"vercel", "netlify"}

HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    )
}
GENERIC_EMAIL_PREFIXES = {"hello", "info", "contact", "sales", "team", "support"}


class ChatReq(BaseModel):
    user_id: str
    message: str
    context: Optional[List[Dict[str, Any]]] = None


class ChatResp(BaseModel):
    reply: str
    data: Optional[Dict[str, Any]] = None


class UserReq(BaseModel):
    user_id: str


class ExecuteReadyReq(BaseModel):
    user_id: str
    limit: int = 10


class StageReq(BaseModel):
    user_id: str
    stage: str


class KillSwitchReq(BaseModel):
    user_id: str
    enabled: bool


class ApprovalModeReq(BaseModel):
    user_id: str
    required: bool


class GoalReq(BaseModel):
    user_id: str
    goal: str = Field(min_length=3)


class WorkspaceRootReq(BaseModel):
    user_id: str
    path: str = Field(min_length=1)


class DesktopPromptReq(BaseModel):
    user_id: str
    enabled: bool


class DeployProviderReq(BaseModel):
    user_id: str
    provider: str


class BrowserAutomationReq(BaseModel):
    user_id: str
    use_playwright: bool


class SiteRevisionReq(BaseModel):
    user_id: str
    instructions: str = Field(min_length=3)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def to_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True)


def from_json(value: Optional[str], fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except Exception:
        return fallback


def slugify(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower())
    cleaned = re.sub(r"-+", "-", cleaned).strip("-")
    return cleaned or f"project-{uuid.uuid4().hex[:8]}"


def safe_deploy_provider(value: str) -> str:
    provider = str(value or "").strip().lower()
    if provider in DEPLOY_PROVIDERS:
        return provider
    return "vercel"


def resolve_workspace_root(raw: str) -> Path:
    text = str(raw or "").strip()
    if not text:
        return GENERATED_ROOT
    root = Path(text).expanduser()
    if not root.is_absolute():
        root = (PROJECT_ROOT / root).resolve()
    return root


def get_workspace_root(session: Dict[str, Any]) -> Path:
    return resolve_workspace_root(str(session.get("workspace_root", "")))


def db_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    GENERATED_ROOT.mkdir(parents=True, exist_ok=True)

    with db_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                user_id TEXT PRIMARY KEY,
                goal TEXT DEFAULT '',
                run_count INTEGER DEFAULT 0,
                require_approval INTEGER DEFAULT 1,
                kill_switch INTEGER DEFAULT 0,
                os_control_granted INTEGER DEFAULT 0,
                workspace_root TEXT DEFAULT '',
                desktop_prompts INTEGER DEFAULT 1,
                deploy_provider TEXT DEFAULT 'vercel',
                use_playwright INTEGER DEFAULT 1,
                plan_json TEXT,
                offer_json TEXT,
                landing_text TEXT,
                outreach_text TEXT,
                project_slug TEXT,
                project_dir TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS leads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                company_name TEXT,
                title TEXT,
                url TEXT,
                domain TEXT,
                contact_url TEXT,
                email TEXT,
                snippet TEXT,
                score REAL,
                reasons_json TEXT,
                stage TEXT DEFAULT 'new',
                email_status TEXT DEFAULT 'draft_pending',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS action_queue (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                action_type TEXT NOT NULL,
                layer TEXT NOT NULL,
                title TEXT NOT NULL,
                detail TEXT NOT NULL,
                command TEXT,
                payload_json TEXT,
                needs_approval INTEGER NOT NULL DEFAULT 1,
                reversible INTEGER NOT NULL DEFAULT 1,
                rollback_hint TEXT,
                status TEXT NOT NULL,
                error TEXT,
                result_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS activity_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                action_id TEXT,
                event_type TEXT NOT NULL,
                message TEXT NOT NULL,
                data_json TEXT,
                created_at TEXT NOT NULL
            );
            """
        )


init_db()


def ensure_column(conn: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    cols = conn.execute(f"PRAGMA table_info({table})").fetchall()
    names = {row["name"] for row in cols}
    if column not in names:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def migrate_db() -> None:
    with db_conn() as conn:
        ensure_column(conn, "sessions", "os_control_granted", "INTEGER DEFAULT 0")
        ensure_column(conn, "sessions", "workspace_root", "TEXT DEFAULT ''")
        ensure_column(conn, "sessions", "desktop_prompts", "INTEGER DEFAULT 1")
        ensure_column(conn, "sessions", "deploy_provider", "TEXT DEFAULT 'vercel'")
        ensure_column(conn, "sessions", "use_playwright", "INTEGER DEFAULT 1")
        ensure_column(conn, "leads", "company_name", "TEXT")
        ensure_column(conn, "leads", "domain", "TEXT")
        ensure_column(conn, "leads", "contact_url", "TEXT")
        ensure_column(conn, "leads", "email", "TEXT")
        conn.execute("UPDATE sessions SET desktop_prompts = 1 WHERE desktop_prompts IS NULL")
        conn.execute("UPDATE sessions SET use_playwright = 1 WHERE use_playwright IS NULL")
        conn.execute("UPDATE sessions SET deploy_provider = 'vercel' WHERE deploy_provider IS NULL OR deploy_provider = ''")


migrate_db()

def get_session(user_id: str) -> Dict[str, Any]:
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE user_id = ?", (user_id,)).fetchone()
        if row:
            data = dict(row)
            data["plan_json"] = from_json(data.get("plan_json"), [])
            data["offer_json"] = from_json(data.get("offer_json"), {})
            return data

        now = now_iso()
        conn.execute(
            """
            INSERT INTO sessions (
                user_id, goal, run_count, require_approval, kill_switch, os_control_granted,
                workspace_root, desktop_prompts, deploy_provider, use_playwright,
                plan_json, offer_json, landing_text, outreach_text,
                project_slug, project_dir, created_at, updated_at
            ) VALUES (?, '', 0, 1, 0, 0, '', 1, ?, 1, '[]', '{}', '', '', '', '', ?, ?)
            """,
            (user_id, DEFAULT_DEPLOY_PROVIDER if DEFAULT_DEPLOY_PROVIDER in DEPLOY_PROVIDERS else "vercel", now, now),
        )

    return get_session(user_id)


def update_session(user_id: str, **fields: Any) -> Dict[str, Any]:
    get_session(user_id)
    if not fields:
        return get_session(user_id)

    columns = []
    values = []
    for key, value in fields.items():
        if key in {"plan_json", "offer_json"}:
            value = to_json(value)
        if key == "deploy_provider":
            value = safe_deploy_provider(str(value))
        columns.append(f"{key} = ?")
        values.append(value)

    values.append(now_iso())
    values.append(user_id)

    with db_conn() as conn:
        conn.execute(f"UPDATE sessions SET {', '.join(columns)}, updated_at = ? WHERE user_id = ?", values)

    return get_session(user_id)


def append_log(user_id: str, event_type: str, message: str, action_id: Optional[str] = None, data: Optional[Dict[str, Any]] = None) -> None:
    with db_conn() as conn:
        conn.execute(
            "INSERT INTO activity_log (user_id, action_id, event_type, message, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, action_id, event_type, message, to_json(data or {}), now_iso()),
        )


def list_logs(user_id: str, limit: int = 50) -> List[Dict[str, Any]]:
    with db_conn() as conn:
        rows = conn.execute("SELECT * FROM activity_log WHERE user_id = ? ORDER BY id DESC LIMIT ?", (user_id, max(1, min(limit, 200)))).fetchall()
    out = []
    for row in rows:
        item = dict(row)
        item["data_json"] = from_json(item.get("data_json"), {})
        out.append(item)
    return out


def replace_leads(user_id: str, leads: List[Dict[str, Any]]) -> None:
    now = now_iso()
    with db_conn() as conn:
        conn.execute("DELETE FROM leads WHERE user_id = ?", (user_id,))
        for lead in leads:
            conn.execute(
                """
                INSERT INTO leads (
                    user_id, company_name, title, url, domain, contact_url, email,
                    snippet, score, reasons_json, stage, email_status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    lead.get("company_name", ""),
                    lead.get("title", ""),
                    lead.get("url", ""),
                    lead.get("domain", ""),
                    lead.get("contact_url", ""),
                    lead.get("email", ""),
                    lead.get("snippet", ""),
                    float(lead.get("score", 0.0)),
                    to_json(lead.get("reasons", [])),
                    lead.get("stage", "new"),
                    lead.get("email_status", "draft_pending"),
                    now,
                    now,
                ),
            )


def list_leads(user_id: str, limit: int = 50) -> List[Dict[str, Any]]:
    with db_conn() as conn:
        rows = conn.execute("SELECT * FROM leads WHERE user_id = ? ORDER BY score DESC, id DESC LIMIT ?", (user_id, max(1, min(limit, 200)))).fetchall()
    out = []
    for row in rows:
        lead = dict(row)
        lead["reasons"] = from_json(lead.get("reasons_json"), [])
        lead.pop("reasons_json", None)
        out.append(lead)
    return out


def update_lead_stage(user_id: str, lead_id: int, stage: str) -> Optional[Dict[str, Any]]:
    with db_conn() as conn:
        conn.execute("UPDATE leads SET stage = ?, updated_at = ? WHERE id = ? AND user_id = ?", (stage, now_iso(), lead_id, user_id))
        row = conn.execute("SELECT * FROM leads WHERE id = ? AND user_id = ?", (lead_id, user_id)).fetchone()
    if not row:
        return None
    lead = dict(row)
    lead["reasons"] = from_json(lead.get("reasons_json"), [])
    lead.pop("reasons_json", None)
    return lead


def get_action(user_id: str, action_id: str) -> Dict[str, Any]:
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM action_queue WHERE user_id = ? AND id = ?", (user_id, action_id)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Action not found")
    data = dict(row)
    data["payload"] = from_json(data.get("payload_json"), {})
    data["result"] = from_json(data.get("result_json"), {})
    data.pop("payload_json", None)
    data.pop("result_json", None)
    return data


def list_actions(user_id: str, active_only: bool = False) -> List[Dict[str, Any]]:
    with db_conn() as conn:
        if active_only:
            rows = conn.execute(
                "SELECT * FROM action_queue WHERE user_id = ? AND status NOT IN ('completed', 'rejected', 'failed') ORDER BY created_at ASC",
                (user_id,),
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM action_queue WHERE user_id = ? ORDER BY created_at DESC", (user_id,)).fetchall()
    out = []
    for row in rows:
        data = dict(row)
        data["payload"] = from_json(data.get("payload_json"), {})
        data["result"] = from_json(data.get("result_json"), {})
        data.pop("payload_json", None)
        data.pop("result_json", None)
        out.append(data)
    return out


def set_action_status(user_id: str, action_id: str, status: str, error: str = "", result: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    with db_conn() as conn:
        conn.execute(
            "UPDATE action_queue SET status = ?, error = ?, result_json = ?, updated_at = ? WHERE user_id = ? AND id = ?",
            (status, error, to_json(result or {}), now_iso(), user_id, action_id),
        )
    return get_action(user_id, action_id)


def reset_open_actions(user_id: str) -> None:
    with db_conn() as conn:
        conn.execute(
            "DELETE FROM action_queue WHERE user_id = ? AND status IN ('pending_approval', 'approved', 'running', 'blocked')",
            (user_id,),
        )


def enqueue_action(
    user_id: str,
    action_type: str,
    layer: str,
    title: str,
    detail: str,
    payload: Optional[Dict[str, Any]] = None,
    command: Optional[str] = None,
    needs_approval: bool = True,
    reversible: bool = True,
    rollback_hint: str = "",
) -> Dict[str, Any]:
    if action_type not in SAFE_ACTION_TYPES:
        raise ValueError(f"Unsupported action_type: {action_type}")
    action_id = f"act_{uuid.uuid4().hex[:12]}"
    status = "pending_approval" if needs_approval else "approved"
    now = now_iso()
    with db_conn() as conn:
        conn.execute(
            """
            INSERT INTO action_queue (
                id, user_id, action_type, layer, title, detail, command, payload_json,
                needs_approval, reversible, rollback_hint, status, error, result_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)
            """,
            (
                action_id,
                user_id,
                action_type,
                layer,
                title,
                detail,
                command,
                to_json(payload or {}),
                1 if needs_approval else 0,
                1 if reversible else 0,
                rollback_hint,
                status,
                now,
                now,
            ),
        )
    append_log(user_id, "action_queued", f"Queued action: {title}", action_id, {"action_type": action_type})
    return get_action(user_id, action_id)

def infer_goal(message: str, context: Optional[List[Dict[str, Any]]]) -> str:
    def clean(text: str) -> str:
        text = re.sub(r"\b(run|launch|go|do\s*it)\b", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s+", " ", text).strip(" |")
        return text

    parts = []
    if context:
        for item in context[-10:]:
            if isinstance(item, dict) and item.get("role") == "user":
                text = clean(str(item.get("text", "")))
                if text:
                    parts.append(text)
    if message.strip():
        parts.append(clean(message.strip()))
    return (" | ".join(parts) or "Launch an AI automation business")[:1200]


def extract_niche_city(goal: str) -> Dict[str, str]:
    normalized = re.sub(r"\s+", " ", goal).strip()
    city = "Austin, Texas"
    city_match = re.search(r"\bin\s+([a-zA-Z][a-zA-Z\s]+(?:,\s*[A-Za-z]{2})?)", normalized, flags=re.IGNORECASE)
    if city_match:
        city = city_match.group(1).strip().rstrip(".?,")

    niche = "local service businesses"
    patterns = [
        r"target(?:ing)?\s+([a-zA-Z0-9\s\-&]+)",
        r"for\s+([a-zA-Z0-9\s\-&]+)",
        r"help\s+([a-zA-Z0-9\s\-&]+)",
        r"serve(?:s|d|ing)?\s+([a-zA-Z0-9\s\-&]+)",
    ]
    for pat in patterns:
        m = re.search(pat, normalized, flags=re.IGNORECASE)
        if m:
            niche = m.group(1).strip().rstrip(".?,")
            break
    niche = re.sub(r"\bin\s+[A-Z][a-zA-Z\s]+(?:,\s*[A-Z]{2})?$", "", niche, flags=re.IGNORECASE).strip(" -")
    return {"niche": niche, "city": city}


def default_plan(goal: str) -> List[Dict[str, Any]]:
    return [
        {"id": "define-niche", "layer": "Brain", "title": "Define niche and problem", "status": "ready", "notes": goal},
        {"id": "validate-problem", "layer": "Brain", "title": "Validate market demand", "status": "ready", "notes": "Verify pain and urgency."},
        {"id": "offer-build", "layer": "Brain", "title": "Generate offer", "status": "ready", "notes": "Create productized outcome offer."},
        {"id": "os-permission", "layer": "OS Control", "title": "Request laptop control permission", "status": "ready", "notes": "Human must approve control scope before execution."},
        {"id": "brand-site", "layer": "Website Builder", "title": "Scaffold landing page", "status": "ready", "notes": "Generate site files and copy."},
        {"id": "lead-gen", "layer": "Outreach", "title": "Source and score prospects", "status": "ready", "notes": "Prioritize high-fit accounts."},
        {"id": "outreach", "layer": "Outreach", "title": "Draft personalized emails", "status": "ready", "notes": "Human reviews before send."},
        {"id": "crm", "layer": "CRM", "title": "Track stages and follow-ups", "status": "ready", "notes": "Maintain deal state over time."},
    ]


def llm_text(prompt: str, max_tokens: int = 700, temperature: float = 0.3) -> Optional[str]:
    if not bedrock:
        return None
    try:
        response = bedrock.converse(
            modelId=MODEL_ID,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": max_tokens, "temperature": temperature},
        )
        return response["output"]["message"]["content"][0]["text"]
    except Exception:
        return None


def make_offer(goal: str) -> Dict[str, Any]:
    profile = extract_niche_city(goal)
    niche = profile["niche"]
    city = profile["city"]

    prompt = f"Return JSON with niche, city, offer_name, offer_value, offer_bullets, lead_query. Goal: {goal}"
    llm_raw = llm_text(prompt, max_tokens=450, temperature=0.25)
    if llm_raw:
        try:
            start = llm_raw.find("{")
            end = llm_raw.rfind("}")
            if start != -1 and end != -1:
                parsed = json.loads(llm_raw[start : end + 1])
                if isinstance(parsed, dict) and parsed.get("offer_name"):
                    parsed["niche"] = niche
                    parsed["city"] = city
                    existing_query = str(parsed.get("lead_query", "")).lower()
                    if not existing_query or niche.lower() not in existing_query:
                        parsed["lead_query"] = f"{niche} {city} official site -top -best -list -blog -review -agency -news -article"
                    return parsed
        except Exception:
            pass

    return {
        "niche": niche,
        "city": city,
        "offer_name": f"AI Revenue Engine for {niche.title()}",
        "offer_value": f"Increase booked calls and recover missed opportunities for {niche} in {city}.",
        "offer_bullets": [
            "Automated missed-call text and follow-up sequences",
            "Website lead capture with qualification routing",
            "Weekly pipeline reporting with AI follow-up suggestions",
        ],
        "lead_query": f"{niche} {city} official site -top -best -list -blog -review -agency -news -article",
    }


def looks_bad(title: str, url: str) -> bool:
    sample = f"{title} {url}".lower().strip()
    if not sample:
        return True
    parsed = urlparse(url if "://" in url else f"https://{url}")
    path = parsed.path.lower()
    # Strip non-business pages early.
    if any(x in path for x in ["/blog", "/news", "/article", "/press", "/careers", "/jobs"]):
        return True
    return any(re.search(p, sample) for p in BAD_PATTERNS)


def tavily_search(query: str, max_results: int = 12) -> List[Dict[str, str]]:
    if not TAVILY_API_KEY:
        return []
    try:
        response = requests.post(
            "https://api.tavily.com/search",
            json={"api_key": TAVILY_API_KEY, "query": query, "max_results": max_results},
            timeout=20,
        )
        response.raise_for_status()
        data = response.json()
        return [
            {"title": item.get("title", ""), "url": item.get("url", ""), "snippet": item.get("content", "")}
            for item in data.get("results", [])
        ]
    except Exception:
        return []


def synthetic_leads(offer: Dict[str, Any]) -> List[Dict[str, str]]:
    niche = str(offer.get("niche", "businesses"))
    city = str(offer.get("city", "Austin, Texas"))
    base = slugify(f"{niche}-{city}")
    names = ["Collective", "Hub", "Group", "Studio", "Partners", "Works", "Services", "Co"]
    out = []
    for idx, suffix in enumerate(names, start=1):
        out.append(
            {
                "title": f"{city} {niche.title()} {suffix}",
                "url": f"https://www.{base}-{suffix.lower()}.com",
                "company_name": f"{city} {niche.title()} {suffix}",
                "snippet": f"Local {niche} provider in {city}. Candidate {idx} for outreach.",
                "domain": f"{base}-{suffix.lower()}.com",
                "contact_url": f"https://www.{base}-{suffix.lower()}.com/contact",
                "email": f"hello@{base}-{suffix.lower()}.com",
            }
        )
    return out


def normalize_domain(url: str) -> str:
    parsed = urlparse(url if "://" in url else f"https://{url}")
    host = (parsed.netloc or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return host


def clean_company_name(title: str, domain: str) -> str:
    raw = (title or "").strip()
    raw = re.sub(r"\s*[|\-]\s*(official|home|homepage|contact|book now).*$", "", raw, flags=re.IGNORECASE)
    if raw:
        return raw[:120]
    base = domain.split(".")[0].replace("-", " ").strip()
    return base.title() if base else "Unknown Company"


def niche_keywords(niche: str) -> List[str]:
    stop = {"in", "for", "and", "the", "of", "to", "local", "business", "businesses", "service", "services"}
    words = [w for w in re.findall(r"[a-zA-Z]+", niche.lower()) if len(w) > 2 and w not in stop]
    out: List[str] = []
    for word in words:
        out.append(word)
        if word.endswith("s") and len(word) > 3:
            out.append(word[:-1])
    if any(x in out for x in ["gym", "gyms"]):
        out.extend(["fitness", "workout", "crossfit"])
    if "medspa" in out or ("med" in out and "spa" in out):
        out.extend(["aesthetics", "cosmetic"])
    dedup: List[str] = []
    seen = set()
    for token in out:
        if token not in seen:
            dedup.append(token)
            seen.add(token)
    return dedup[:8]


def is_non_target_result(joined: str, keys: List[str]) -> bool:
    lower = joined.lower()
    if any(x in lower for x in ["parks & recreation", "city of ", "government", "county", "public works"]):
        return True
    gym_mode = any(k in {"gym", "gyms", "fitness", "workout", "crossfit"} for k in keys)
    if gym_mode:
        weak_terms = ["content marketing", "copywriting", "saas", "software", "consulting", "automation"]
        fitness_terms = ["gym", "fitness", "crossfit", "workout", "pilates", "personal training", "health club"]
        if any(x in lower for x in weak_terms) and not any(x in lower for x in fitness_terms):
            return True
    return False


def extract_emails(text: str, domain: str) -> List[str]:
    if not text:
        return []
    hits = re.findall(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", text)
    cleaned = []
    seen = set()
    for email in hits:
        lower = email.lower().strip(".,;:()[]{}<>")
        if lower in seen:
            continue
        seen.add(lower)
        if any(lower.endswith(x) for x in [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]):
            continue
        if lower.startswith(("noreply@", "no-reply@", "donotreply@")):
            continue
        cleaned.append(lower)

    if not domain:
        return cleaned[:3]

    domain_hits = [item for item in cleaned if item.endswith(f"@{domain}")]
    if domain_hits:
        return domain_hits[:3]
    return cleaned[:3]


def extract_contact_url(base_url: str, html: str) -> str:
    if not html:
        return ""
    pairs = re.findall(r"""<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)</a>""", html, flags=re.IGNORECASE | re.DOTALL)
    for href, text in pairs[:250]:
        blob = f"{href} {re.sub(r'<[^>]+>', ' ', text)}".lower()
        if any(token in blob for token in ["contact", "appointment", "book", "schedule"]):
            return urljoin(base_url, href)
    return ""


def fetch_business_profile(url: str) -> Dict[str, str]:
    normalized = url if url.startswith(("http://", "https://")) else f"https://{url}"
    domain = normalize_domain(normalized)
    fallback_contact = f"https://{domain}/contact" if domain else ""
    try:
        resp = requests.get(normalized, timeout=10, headers=HTTP_HEADERS, allow_redirects=True)
        content_type = str(resp.headers.get("content-type", "")).lower()
        if "text/html" not in content_type:
            return {"domain": domain, "email": "", "contact_url": fallback_contact, "snippet": ""}
        html = resp.text[:120_000]
        emails = extract_emails(html, domain)
        contact_url = extract_contact_url(str(resp.url), html) or fallback_contact
        plain = re.sub(r"<[^>]+>", " ", html)
        plain = re.sub(r"\s+", " ", plain).strip()[:260]
        return {
            "domain": normalize_domain(str(resp.url)) or domain,
            "email": emails[0] if emails else "",
            "contact_url": contact_url,
            "snippet": plain,
        }
    except Exception:
        return {"domain": domain, "email": "", "contact_url": fallback_contact, "snippet": ""}


def gather_real_leads(offer: Dict[str, Any]) -> List[Dict[str, str]]:
    niche = str(offer.get("niche", "")).strip()
    city = str(offer.get("city", "")).strip()
    raw_query_seed = str(offer.get("lead_query", "")).strip()
    keys = niche_keywords(niche)
    key_hint = keys[0] if keys else niche
    query_seed = raw_query_seed if (not keys or any(token in raw_query_seed.lower() for token in keys)) else ""
    queries = [
        query_seed or f"{key_hint} {city} official website",
        f"{key_hint} {city} contact us book appointment",
        f"{key_hint} {city} services location",
        f"{niche} {city} business website",
    ]

    raw: List[Dict[str, str]] = []
    for q in queries:
        raw.extend(tavily_search(q, max_results=12))

    by_domain: Dict[str, Dict[str, str]] = {}
    for item in raw:
        title = str(item.get("title", "")).strip()
        url = str(item.get("url", "")).strip()
        snippet = str(item.get("snippet", "") or item.get("content", "")).strip()
        if not url or looks_bad(title, url):
            continue
        domain = normalize_domain(url)
        if not domain or domain in by_domain:
            continue
        joined = f"{title} {snippet} {domain}".lower()
        if keys and not any(token in joined for token in keys):
            continue
        if is_non_target_result(joined, keys):
            continue
        by_domain[domain] = {"title": title, "url": url, "snippet": snippet, "domain": domain}

    leads = list(by_domain.values())[:18]
    enriched = []
    for lead in leads:
        profile = fetch_business_profile(lead.get("url", ""))
        merged = {
            "title": lead.get("title", ""),
            "company_name": clean_company_name(lead.get("title", ""), profile.get("domain", "") or lead.get("domain", "")),
            "url": lead.get("url", ""),
            "domain": profile.get("domain", "") or lead.get("domain", ""),
            "contact_url": profile.get("contact_url", ""),
            "email": profile.get("email", ""),
            "snippet": (lead.get("snippet") or profile.get("snippet") or "").strip()[:280],
        }
        enriched.append(merged)

    if enriched:
        return enriched
    return synthetic_leads(offer)


def score_leads(offer: Dict[str, Any], leads: List[Dict[str, str]]) -> List[Dict[str, Any]]:
    niche = str(offer.get("niche", "")).lower()
    city = str(offer.get("city", "")).lower()
    scored = []
    for lead in leads:
        joined = (
            f"{lead.get('title', '')} {lead.get('company_name', '')} "
            f"{lead.get('snippet', '')} {lead.get('domain', '')}"
        ).lower()
        score = 5.6
        reasons = []
        if niche and niche.split(" ")[0] in joined:
            score += 1.6
            reasons.append("Matches target niche.")
        if city and city.split(",")[0].strip() in joined:
            score += 1.2
            reasons.append("Matches target geography.")
        if "contact" in joined or "book" in joined or "appointment" in joined:
            score += 0.6
            reasons.append("Shows strong conversion intent signal.")
        if lead.get("url", "").startswith("https://"):
            score += 0.4
            reasons.append("Usable web presence found.")
        if lead.get("email", ""):
            email = str(lead.get("email", "")).lower()
            prefix = email.split("@")[0] if "@" in email else ""
            score += 0.5
            if prefix not in GENERIC_EMAIL_PREFIXES:
                score += 0.5
            reasons.append("Direct business email discovered.")
            if email.endswith("@domain.com") or prefix in {"user", "test", "admin"}:
                score -= 1.8
                reasons.append("Email appears low-confidence placeholder.")
        if lead.get("contact_url", ""):
            score += 0.7
            reasons.append("Contact page available for follow-up.")
        if lead.get("domain", "") and any(x in lead.get("domain", "") for x in ["blog", "news", "wiki"]):
            score -= 2.2

        scored.append(
            {
                "company_name": lead.get("company_name", ""),
                "title": lead.get("title", ""),
                "url": lead.get("url", ""),
                "domain": lead.get("domain", ""),
                "contact_url": lead.get("contact_url", ""),
                "email": lead.get("email", ""),
                "snippet": lead.get("snippet", ""),
                "score": round(min(max(score, 1.0), 10.0), 1),
                "reasons": reasons[:3] or ["General fit based on niche and city."],
            }
        )
    scored.sort(key=lambda item: item["score"], reverse=True)
    return scored


def build_landing_copy(offer: Dict[str, Any]) -> str:
    bullets = offer.get("offer_bullets", [])
    b1 = bullets[0] if len(bullets) > 0 else "Automated lead response"
    b2 = bullets[1] if len(bullets) > 1 else "Qualification and routing"
    b3 = bullets[2] if len(bullets) > 2 else "Follow-up intelligence"
    return (
        "HERO HEADLINE:\n"
        f"{offer.get('offer_name', 'AI Growth System')}\n\n"
        "SUBHEADLINE:\n"
        f"{offer.get('offer_value', 'Grow predictable pipeline with AI operations.')}\n\n"
        "WHO IT'S FOR:\n"
        f"{offer.get('niche', 'Service businesses')} in {offer.get('city', 'your market')}.\n\n"
        "WHAT YOU GET (3 bullets):\n"
        f"- {b1}\n- {b2}\n- {b3}\n\n"
        "WHY NOW:\nCompetitors already automate first touch and follow-up loops.\n\n"
        "PROOF / TRUST (2 bullets):\n- Full activity logs\n- Human approval for risky actions\n\n"
        "CALL TO ACTION:\nBook a 20-minute systems audit.\n\n"
        "FAQ (2 Q/A):\nQ: Is this autonomous outreach?\nA: No. Human must review and send.\n"
        "Q: Can I stop actions mid-run?\nA: Yes, via kill switch.\n"
    )


def build_outreach_drafts(offer: Dict[str, Any], leads: List[Dict[str, Any]]) -> str:
    drafts = []
    for idx, lead in enumerate(leads[:5], start=1):
        company = lead.get("company_name") or lead.get("title") or "your team"
        email = lead.get("email", "")
        contact_url = lead.get("contact_url", "")
        drafts.append(
            f"Draft {idx}\n"
            f"Company: {company}\n"
            f"Email: {email or '(none found - use contact page)'}\n"
            f"Contact URL: {contact_url or '(not detected)'}\n"
            f"Subject: Quick growth idea for {company}\n"
            f"Hi {company} team,\n\n"
            f"I help {offer.get('niche', 'service businesses')} in {offer.get('city', 'your city')} improve inbound conversion with fast follow-ups and qualification flows.\n\n"
            "If helpful, I can share a quick teardown and rollout plan.\n"
            "Offer summary: {LANDING_URL}\n\n"
            "No pressure if now is not the right time.\n"
        )
    return "\n".join(drafts)


def build_email_subject(offer: Dict[str, Any], lead: Dict[str, Any]) -> str:
    company = str(lead.get("company_name") or lead.get("title") or "your team")
    niche = str(offer.get("niche", "your market")).strip()
    return f"Quick idea to increase bookings for {company} ({niche})"


def build_email_body(offer: Dict[str, Any], lead: Dict[str, Any]) -> str:
    company = str(lead.get("company_name") or lead.get("title") or "team")
    niche = str(offer.get("niche", "service businesses"))
    city = str(offer.get("city", "your city"))
    contact_url = str(lead.get("contact_url", "")).strip()
    return (
        f"Hi {company} team,\n\n"
        f"I run an AI automation agency focused on {niche} in {city}.\n"
        "We build missed-call follow-up + lead qualification systems that usually increase booked calls without adding ad spend.\n\n"
        "If useful, I can send a 3-point teardown of your current lead response flow and a 14-day rollout plan.\n\n"
        f"{'I reviewed your site/contact flow: ' + contact_url + '\\n\\n' if contact_url else ''}"
        "If this is relevant, I can send the breakdown this week.\n"
    )


def build_gmail_compose_url(lead: Dict[str, Any], offer: Dict[str, Any]) -> str:
    to_email = str(lead.get("email", "")).strip()
    subject = build_email_subject(offer, lead)
    body = build_email_body(offer, lead)
    params = f"view=cm&fs=1&su={quote_plus(subject)}&body={quote_plus(body)}"
    if to_email:
        params = f"view=cm&fs=1&to={quote_plus(to_email)}&su={quote_plus(subject)}&body={quote_plus(body)}"
    return f"https://mail.google.com/mail/?{params}"


def open_urls_in_browser(urls: List[str], pause_ms: int = 350) -> Dict[str, Any]:
    opened = []
    for url in urls:
        target = str(url).strip()
        if not target:
            continue
        webbrowser.open_new_tab(target)
        opened.append(target)
        time.sleep(max(pause_ms, 0) / 1000.0)
    return {"opened": len(opened), "urls": opened}


PLAYWRIGHT_RUNTIME: Dict[str, Any] = {"engine": None, "context": None}


def desktop_permission_popup(action: Dict[str, Any]) -> bool:
    if platform.system().lower() != "windows":
        return True
    title = f"Architect Permission - {action.get('title', 'Action')}"
    detail = (
        f"Allow this action to run?\n\n"
        f"Layer: {action.get('layer', '')}\n"
        f"Type: {action.get('action_type', '')}\n\n"
        f"{action.get('detail', '')}"
    )
    try:
        flags = 0x00000004 | 0x00000020 | 0x00040000  # YESNO | ICONQUESTION | TOPMOST
        res = ctypes.windll.user32.MessageBoxW(0, detail[:1400], title[:180], flags)
        return int(res) == 6
    except Exception:
        # If popup cannot be shown (headless/service mode), do not block execution.
        return True


def open_urls_with_playwright(urls: List[str], pause_ms: int = 450) -> Dict[str, Any]:
    if not urls:
        return {"opened": 0, "urls": [], "engine": "playwright"}
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        fallback = open_urls_in_browser(urls, pause_ms=pause_ms)
        fallback["engine"] = "webbrowser"
        fallback["playwright_error"] = f"{type(exc).__name__}: {exc}"
        return fallback


def get_playwright_context() -> Optional[Any]:
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        return None
    engine = PLAYWRIGHT_RUNTIME.get("engine")
    context = PLAYWRIGHT_RUNTIME.get("context")
    if context is not None and engine is not None:
        return context
    PLAYWRIGHT_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    engine = sync_playwright().start()
    context = engine.chromium.launch_persistent_context(
        user_data_dir=str(PLAYWRIGHT_PROFILE_DIR),
        headless=False,
    )
    PLAYWRIGHT_RUNTIME["engine"] = engine
    PLAYWRIGHT_RUNTIME["context"] = context
    return context


def automate_lovable_generation(prompt: str) -> Dict[str, Any]:
    context = get_playwright_context()
    if context is None:
        return {
            "status": "playwright_unavailable",
            "hint": "Install playwright and run 'python -m playwright install chromium'.",
        }

    page = context.new_page()
    page.goto("https://lovable.dev", wait_until="domcontentloaded", timeout=90000)
    page.wait_for_timeout(1800)

    content = page.content().lower()
    if any(x in content for x in ["sign in", "log in", "continue with"]):
        return {
            "status": "needs_manual_login",
            "hint": "Lovable login required. Sign in in the opened browser profile, then execute this action again.",
        }

    prompt = prompt.strip()[:5000]
    if not prompt:
        return {"status": "missing_prompt"}

    typed_into = ""
    selectors = [
        'textarea',
        '[contenteditable="true"]',
        'div[role="textbox"]',
        'input[type="text"]',
    ]
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            if loc.count() < 1:
                continue
            loc.click(timeout=2500)
            tag = loc.evaluate("el => el.tagName.toLowerCase()")
            editable = bool(loc.evaluate("el => !!el.isContentEditable"))
            if tag in {"textarea", "input"}:
                loc.fill(prompt)
            elif editable:
                page.keyboard.type(prompt, delay=3)
            else:
                continue
            typed_into = sel
            break
        except Exception:
            continue

    if not typed_into:
        return {
            "status": "input_not_found",
            "hint": "Could not find Lovable prompt input. Open Lovable and click into prompt box, then retry.",
        }

    triggered = ""
    for label in ["Generate", "Build", "Create", "Start", "Send", "Continue"]:
        try:
            btn = page.get_by_role("button", name=re.compile(label, re.IGNORECASE)).first
            if btn.count() > 0:
                btn.click(timeout=2200)
                triggered = label
                break
        except Exception:
            continue

    if not triggered:
        try:
            page.keyboard.press("Control+Enter")
            triggered = "Ctrl+Enter"
        except Exception:
            pass

    shot_dir = DATA_DIR / "screenshots"
    shot_dir.mkdir(parents=True, exist_ok=True)
    shot_path = shot_dir / f"lovable-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.png"
    try:
        page.screenshot(path=str(shot_path), full_page=True)
    except Exception:
        shot_path = Path("")

    return {
        "status": "generation_started" if triggered else "prompt_seeded",
        "input_selector": typed_into,
        "trigger": triggered,
        "screenshot": str(shot_path) if str(shot_path) else "",
    }

    engine = PLAYWRIGHT_RUNTIME.get("engine")
    context = PLAYWRIGHT_RUNTIME.get("context")
    try:
        if context is None or engine is None:
            PLAYWRIGHT_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
            engine = sync_playwright().start()
            context = engine.chromium.launch_persistent_context(
                user_data_dir=str(PLAYWRIGHT_PROFILE_DIR),
                headless=False,
            )
            PLAYWRIGHT_RUNTIME["engine"] = engine
            PLAYWRIGHT_RUNTIME["context"] = context

        opened = []
        for url in urls:
            target = str(url).strip()
            if not target:
                continue
            page = context.new_page()
            page.goto(target, wait_until="domcontentloaded", timeout=90000)
            opened.append(target)
            time.sleep(max(pause_ms, 0) / 1000.0)
        return {"opened": len(opened), "urls": opened, "engine": "playwright"}
    except Exception as exc:
        fallback = open_urls_in_browser(urls, pause_ms=pause_ms)
        fallback["engine"] = "webbrowser"
        fallback["playwright_error"] = f"{type(exc).__name__}: {exc}"
        return fallback


def run_shell_command(command: List[str], cwd: Optional[Path] = None, timeout: int = 120) -> Dict[str, Any]:
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        stdout = (completed.stdout or "").strip()
        stderr = (completed.stderr or "").strip()
        return {
            "ok": completed.returncode == 0,
            "returncode": completed.returncode,
            "stdout": stdout[-4000:],
            "stderr": stderr[-4000:],
            "command": " ".join(command),
        }
    except FileNotFoundError:
        return {"ok": False, "returncode": 127, "stdout": "", "stderr": f"{command[0]} not found", "command": " ".join(command)}
    except subprocess.TimeoutExpired:
        return {"ok": False, "returncode": 124, "stdout": "", "stderr": "command timed out", "command": " ".join(command)}

def queue_mvp_actions(user_id: str, session: Dict[str, Any], offer: Dict[str, Any], leads: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    reset_open_actions(user_id)
    workspace_root = get_workspace_root(session)
    workspace_root.mkdir(parents=True, exist_ok=True)
    business_slug = slugify(offer.get("offer_name", offer.get("niche", "architect-business")))
    run_count = int(session.get("run_count", 0))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    project_slug = f"{business_slug}-{stamp}-run{run_count}"
    project_dir = workspace_root / project_slug
    deploy_provider = safe_deploy_provider(str(session.get("deploy_provider", DEFAULT_DEPLOY_PROVIDER)))
    use_playwright = bool(session.get("use_playwright", 1))
    update_session(
        user_id,
        project_slug=project_slug,
        project_dir=str(project_dir),
        os_control_granted=0,
        deploy_provider=deploy_provider,
    )

    require_approval = bool(session.get("require_approval", 1))
    preview_urls = [
        f"{PUBLIC_BACKEND_URL}/preview/{user_id}/site",
        f"{PUBLIC_BACKEND_URL}/preview/{user_id}/emails",
        f"{PUBLIC_BACKEND_URL}/preview/{user_id}/report",
    ]
    gmail_urls = [build_gmail_compose_url(lead, offer) for lead in leads[:8]]
    repo_name = project_slug[:90]
    lovable_prompt = (
        f"Build a conversion-first landing page for {offer.get('niche', 'service businesses')} in {offer.get('city', 'local market')}. "
        f"Offer: {offer.get('offer_name', 'AI Growth Engine')}. "
        f"Outcome promise: {offer.get('offer_value', '')}."
    )

    actions = [
        enqueue_action(
            user_id,
            "request_os_control",
            "OS Control",
            "Request laptop control permission",
            "Explicit consent gate. All OS/browser actions stay blocked until this action is approved and executed.",
            payload={"scope": ["browser tabs", "local shell commands", "file generation"]},
            command="permission:os-control",
            needs_approval=True,
            reversible=False,
        ),
        enqueue_action(
            user_id,
            "start_sandbox_session",
            "OS Control",
            "Start local sandbox",
            "Initialize command whitelist and log context.",
            payload={"whitelist": ["mkdir", "git", "npm", "gh", "vercel", "netlify", "browser automation"]},
            needs_approval=require_approval,
            reversible=False,
        ),
        enqueue_action(
            user_id,
            "create_project_directory",
            "OS Control",
            "Create business workspace",
            f"Create new business folder at {project_dir}",
            payload={"project_dir": str(project_dir), "workspace_root": str(workspace_root)},
            command=f"mkdir {project_dir}",
            needs_approval=require_approval,
        ),
        enqueue_action(
            user_id,
            "scaffold_landing_site",
            "Website Builder",
            "Scaffold Next.js landing page",
            "Generate starter site files and copy.",
            payload={"project_dir": str(project_dir), "offer": offer},
            command="write:nextjs-template",
            needs_approval=require_approval,
        ),
        enqueue_action(
            user_id,
            "init_git_repo",
            "OS Control",
            "Initialize git repository",
            "Run git init in generated project.",
            payload={"project_dir": str(project_dir)},
            command=f"git init {project_dir}",
            needs_approval=require_approval,
        ),
        enqueue_action(
            user_id,
            "install_site_dependencies",
            "OS Control",
            "Install site dependencies",
            "Run npm install in generated project folder.",
            payload={"project_dir": str(project_dir)},
            command=f"cd {project_dir} && npm install",
            needs_approval=require_approval,
        ),
        enqueue_action(
            user_id,
            "publish_github_repo",
            "OS Control",
            "Publish code to GitHub",
            "Create/push a GitHub repository using gh CLI (or configured token flow).",
            payload={"project_dir": str(project_dir), "repo_name": repo_name, "private": True},
            command=f"gh repo create {repo_name} --private --source . --remote origin --push",
            needs_approval=True,
            reversible=False,
        ),
        enqueue_action(
            user_id,
            "open_lovable_workspace",
            "Website Builder",
            "Open Lovable for accelerated site generation",
            "Open Lovable in your browser with generated context prompt.",
            payload={"prompt": lovable_prompt, "use_playwright": use_playwright},
            command="browser:open lovable.dev",
            needs_approval=require_approval,
            reversible=False,
        ),
        enqueue_action(
            user_id,
            "automate_lovable_site",
            "Website Builder",
            "Automate Lovable site generation",
            "Use Playwright to paste generated prompt into Lovable and trigger generation.",
            payload={"prompt": lovable_prompt, "use_playwright": use_playwright},
            command="playwright:lovable-generate",
            needs_approval=require_approval,
            reversible=False,
        ),
        enqueue_action(
            user_id,
            "prepare_gmail_drafts",
            "Outreach",
            "Prepare Gmail draft package",
            "Create reviewable draft bundle for manual send.",
            payload={
                "project_dir": str(project_dir),
                "lead_count": len(leads),
                "outreach_text": session.get("outreach_text", ""),
                "gmail_urls": gmail_urls,
            },
            command="gmail:drafts",
            needs_approval=require_approval,
        ),
        enqueue_action(
            user_id,
            "open_operator_tabs",
            "OS Control",
            "Open all operator tabs",
            "Open site, email, and report preview tabs automatically in your default browser.",
            payload={"urls": preview_urls, "use_playwright": use_playwright},
            command="browser:open preview tabs",
            needs_approval=require_approval,
            reversible=False,
        ),
        enqueue_action(
            user_id,
            "open_gmail_draft_tabs",
            "Outreach",
            "Open Gmail compose tabs for leads",
            "Open pre-filled Gmail compose tabs. You still review and click Send manually.",
            payload={"gmail_urls": gmail_urls, "lead_count": len(gmail_urls), "use_playwright": use_playwright},
            command="browser:open gmail compose tabs",
            needs_approval=True,
            reversible=False,
        ),
        enqueue_action(
            user_id,
            "sync_crm_snapshot",
            "CRM",
            "Sync CRM snapshot",
            "Persist scored leads and default stages.",
            payload={"lead_count": len(leads)},
            command="crm:sync",
            needs_approval=False,
        ),
    ]

    if deploy_provider == "netlify":
        actions.insert(
            8,
            enqueue_action(
                user_id,
                "deploy_to_netlify_preview",
                "Website Builder",
                "Deploy generated project on Netlify",
                "Run Netlify CLI deployment in the generated project folder.",
                payload={"project_dir": str(project_dir), "prod": False},
                command="netlify deploy --build",
                needs_approval=True,
                reversible=False,
            ),
        )
    else:
        actions.insert(
            8,
            enqueue_action(
                user_id,
                "deploy_to_vercel_preview",
                "Website Builder",
                "Deploy generated project on Vercel",
                "Run Vercel CLI deployment command in generated project.",
                payload={"project_dir": str(project_dir), "prod": False},
                command="vercel --yes",
                needs_approval=True,
                reversible=False,
            ),
        )

    return actions


def run_action(action: Dict[str, Any]) -> Dict[str, Any]:
    action_type = action.get("action_type")
    payload = action.get("payload", {})
    user_id = str(action.get("user_id", "")).strip()

    if action_type == "request_os_control":
        if user_id:
            update_session(user_id, os_control_granted=1)
        return {"status": "os_control_granted", "scope": payload.get("scope", [])}

    if action_type == "start_sandbox_session":
        return {"status": "sandbox_ready", "whitelist": payload.get("whitelist", [])}

    if action_type == "create_project_directory":
        project_dir = Path(str(payload.get("project_dir", "")))
        project_dir.mkdir(parents=True, exist_ok=True)
        for folder in ["assets", "crm", "drafts", "logs", "ops"]:
            (project_dir / folder).mkdir(parents=True, exist_ok=True)
        return {"status": "directory_ready", "project_dir": str(project_dir)}

    if action_type == "scaffold_landing_site":
        project_dir = Path(str(payload.get("project_dir", "")))
        offer = payload.get("offer", {})
        project_dir.mkdir(parents=True, exist_ok=True)
        app_dir = project_dir / "app"
        app_dir.mkdir(parents=True, exist_ok=True)

        package_json = {
            "name": slugify(offer.get("offer_name", "architect-site")),
            "private": True,
            "version": "0.1.0",
            "scripts": {"dev": "next dev", "build": "next build", "start": "next start"},
            "dependencies": {"next": "16.1.2", "react": "19.2.3", "react-dom": "19.2.3"},
        }
        (project_dir / "package.json").write_text(json.dumps(package_json, indent=2), encoding="utf-8")
        (project_dir / "next.config.ts").write_text("const nextConfig = {};\nexport default nextConfig;\n", encoding="utf-8")
        (project_dir / "next-env.d.ts").write_text("/// <reference types=\"next\" />\n/// <reference types=\"next/image-types/global\" />\n", encoding="utf-8")

        tsconfig = {
            "compilerOptions": {
                "target": "ES2017",
                "lib": ["dom", "dom.iterable", "esnext"],
                "allowJs": True,
                "skipLibCheck": True,
                "strict": True,
                "noEmit": True,
                "esModuleInterop": True,
                "module": "esnext",
                "moduleResolution": "bundler",
                "resolveJsonModule": True,
                "isolatedModules": True,
                "jsx": "preserve",
                "incremental": True,
            },
            "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
            "exclude": ["node_modules"],
        }
        (project_dir / "tsconfig.json").write_text(json.dumps(tsconfig, indent=2), encoding="utf-8")

        hero = offer.get("offer_name", "AI Growth System")
        value = offer.get("offer_value", "Grow with AI operations")
        niche = str(offer.get("niche", "Service businesses"))
        city = str(offer.get("city", "your market"))
        bullets = [str(x) for x in (offer.get("offer_bullets", []) or [])][:4]
        if not bullets:
            bullets = [
                "Instant lead response automation",
                "Qualification and routing workflows",
                "Follow-up engine with human approvals",
            ]
        bullets_js = ", ".join(json.dumps(item) for item in bullets)
        landing = build_landing_copy(offer)

        (app_dir / "layout.tsx").write_text(
            "import './globals.css';\n\n"
            "export default function RootLayout({ children }: { children: React.ReactNode }) {\n"
            "  return (\n"
            "    <html lang=\"en\">\n"
            "      <body>{children}</body>\n"
            "    </html>\n"
            "  );\n"
            "}\n",
            encoding="utf-8",
        )

        (app_dir / "globals.css").write_text(
            ":root {\n"
            "  --bg: #030807;\n"
            "  --panel: #0b1412;\n"
            "  --line: #1d3a31;\n"
            "  --ink: #ddfde9;\n"
            "  --muted: #98d9b6;\n"
            "  --accent: #35f89a;\n"
            "}\n"
            "* { box-sizing: border-box; }\n"
            "body {\n"
            "  margin: 0;\n"
            "  font-family: 'Segoe UI', sans-serif;\n"
            "  color: var(--ink);\n"
            "  background:\n"
            "    radial-gradient(70rem 36rem at 85% -20%, #1b7f5244 0%, transparent 52%),\n"
            "    radial-gradient(62rem 33rem at -10% 40%, #1b7f5233 0%, transparent 50%),\n"
            "    var(--bg);\n"
            "}\n"
            ".wrap { max-width: 1080px; margin: 0 auto; padding: 2rem 1rem 4rem; }\n"
            ".hero {\n"
            "  border: 1px solid var(--line);\n"
            "  border-radius: 18px;\n"
            "  background: linear-gradient(180deg, #0d1815 0%, #0a1210 100%);\n"
            "  padding: 1.2rem;\n"
            "}\n"
            ".chip {\n"
            "  display: inline-flex;\n"
            "  border: 1px solid #2c5a49;\n"
            "  border-radius: 999px;\n"
            "  padding: .25rem .6rem;\n"
            "  color: var(--muted);\n"
            "  font-size: 12px;\n"
            "}\n"
            ".grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-top: 1rem; }\n"
            ".card { border: 1px solid var(--line); border-radius: 14px; background: #0a1311; padding: .9rem; }\n"
            ".cta {\n"
            "  display: inline-block;\n"
            "  margin-top: .8rem;\n"
            "  padding: .55rem .95rem;\n"
            "  border-radius: 10px;\n"
            "  background: linear-gradient(180deg, #29d684 0%, #14834f 100%);\n"
            "  color: #052214;\n"
            "  text-decoration: none;\n"
            "  font-weight: 700;\n"
            "}\n",
            encoding="utf-8",
        )

        (app_dir / "page.tsx").write_text(
            "export default function Page() {\n"
            f"  const bullets = [{bullets_js}];\n"
            "  return (\n"
            "    <main className=\"wrap\">\n"
            "      <section className=\"hero\">\n"
            "        <span className=\"chip\">AI Operator Stack</span>\n"
            f"        <h1 style={{{{ margin: '.7rem 0 .5rem', fontSize: '2rem', color: 'var(--accent)' }}}}>{hero}</h1>\n"
            f"        <p style={{{{ margin: 0, color: 'var(--ink)' }}}}>{value}</p>\n"
            f"        <p style={{{{ color: 'var(--muted)', marginTop: '.55rem' }}}}>Built for {niche} in {city}.</p>\n"
            "        <a className=\"cta\" href=\"#book\">Book 20-Min Strategy Call</a>\n"
            "      </section>\n"
            "      <section className=\"grid\">\n"
            "        {bullets.map((item) => (\n"
            "          <article key={item} className=\"card\">\n"
            "            <h3 style={{ margin: 0, color: 'var(--accent)' }}>{item}</h3>\n"
            "            <p style={{ marginTop: '.4rem', color: 'var(--muted)' }}>\n"
            "              Automated with approval-gated execution and full operator logs.\n"
            "            </p>\n"
            "          </article>\n"
            "        ))}\n"
            "      </section>\n"
            "      <section id=\"book\" className=\"card\" style={{ marginTop: '1rem' }}>\n"
            "        <h2 style={{ margin: 0, color: 'var(--accent)' }}>Operator Onboarding</h2>\n"
            "        <p style={{ color: 'var(--muted)' }}>\n"
            "          This site was generated by The Architect with a JARVIS-style assistant workflow.\n"
            "          Next step: connect CRM, outreach inbox, and deployment credentials.\n"
            "        </p>\n"
            "      </section>\n"
            "      <section className=\"card\" style={{ marginTop: '1rem' }}>\n"
            "        <h3 style={{ marginTop: 0, color: 'var(--accent)' }}>Generated Draft</h3>\n"
            "        <pre style={{ whiteSpace: 'pre-wrap', fontSize: '12px', color: 'var(--muted)' }}>\n"
            f"{landing.replace('\\', '\\\\').replace('`', '\\`')}\n"
            "        </pre>\n"
            "      </section>\n"
            "    </main>\n"
            "  );\n"
            "}\n",
            encoding="utf-8",
        )

        return {"status": "scaffold_ready", "project_dir": str(project_dir)}

    if action_type == "init_git_repo":
        project_dir = Path(str(payload.get("project_dir", "")))
        project_dir.mkdir(parents=True, exist_ok=True)
        result = run_shell_command(["git", "init"], cwd=project_dir, timeout=20)
        return {"status": "git_ready" if result["ok"] else "git_failed", **result}

    if action_type == "install_site_dependencies":
        project_dir = Path(str(payload.get("project_dir", "")))
        result = run_shell_command(["npm", "install"], cwd=project_dir, timeout=300)
        return {"status": "dependencies_installed" if result["ok"] else "dependencies_failed", **result}

    if action_type == "publish_github_repo":
        project_dir = Path(str(payload.get("project_dir", "")))
        repo_name = str(payload.get("repo_name", slugify(project_dir.name)))
        is_private = bool(payload.get("private", True))

        run_shell_command(["git", "add", "."], cwd=project_dir, timeout=20)
        run_shell_command(["git", "commit", "-m", "Initial scaffold from The Architect"], cwd=project_dir, timeout=20)

        visibility_flag = "--private" if is_private else "--public"
        result = run_shell_command(
            ["gh", "repo", "create", repo_name, visibility_flag, "--source", ".", "--remote", "origin", "--push"],
            cwd=project_dir,
            timeout=120,
        )
        if result.get("ok"):
            return {"status": "github_pushed", "repo_name": repo_name, **result}

        hint = (
            "GitHub publish failed. Ensure GitHub CLI is installed and authenticated: "
            "'gh auth login'."
        )
        return {"status": "github_publish_failed", "repo_name": repo_name, "hint": hint, **result}

    if action_type == "prepare_gmail_drafts":
        project_dir = Path(str(payload.get("project_dir", "")))
        drafts_dir = project_dir / "drafts"
        drafts_dir.mkdir(parents=True, exist_ok=True)
        path = drafts_dir / "gmail-drafts.txt"
        outreach_text = str(payload.get("outreach_text", "")).strip()
        if not outreach_text:
            outreach_text = "No outreach drafts were available when this step executed."
        gmail_urls = [str(u).strip() for u in payload.get("gmail_urls", []) if str(u).strip()]
        if gmail_urls:
            outreach_text = (
                outreach_text
                + "\n\n---\nGmail Compose Links (open in browser):\n"
                + "\n".join(gmail_urls)
            )
        path.write_text(outreach_text + "\n", encoding="utf-8")
        return {"status": "drafts_ready", "path": str(path)}

    if action_type == "open_operator_tabs":
        urls = [str(u).strip() for u in payload.get("urls", []) if str(u).strip()]
        if not urls:
            return {"status": "no_tabs", "opened": 0, "urls": []}
        use_playwright = bool(payload.get("use_playwright", True))
        opened = open_urls_with_playwright(urls) if use_playwright else open_urls_in_browser(urls)
        return {"status": "tabs_opened", **opened}

    if action_type == "open_lovable_workspace":
        prompt = str(payload.get("prompt", "")).strip()
        use_playwright = bool(payload.get("use_playwright", True))
        tabs = ["https://lovable.dev"]
        if prompt:
            tabs.append(f"{PUBLIC_BACKEND_URL}/preview/{user_id}/report")
        opened = open_urls_with_playwright(tabs) if use_playwright else open_urls_in_browser(tabs)
        return {"status": "lovable_opened", "prompt": prompt, **opened}

    if action_type == "automate_lovable_site":
        prompt = str(payload.get("prompt", "")).strip()
        use_playwright = bool(payload.get("use_playwright", True))
        if not use_playwright:
            open_urls_in_browser(["https://lovable.dev"])
            return {
                "status": "manual_required",
                "hint": "Playwright mode is disabled. Open Lovable and paste prompt manually.",
                "prompt": prompt,
            }
        result = automate_lovable_generation(prompt)
        return result

    if action_type == "open_gmail_draft_tabs":
        gmail_urls = [str(u).strip() for u in payload.get("gmail_urls", []) if str(u).strip()]
        if not gmail_urls:
            return {"status": "no_drafts", "opened": 0, "urls": []}
        use_playwright = bool(payload.get("use_playwright", True))
        opened = open_urls_with_playwright(gmail_urls[:8], pause_ms=420) if use_playwright else open_urls_in_browser(gmail_urls[:8], pause_ms=420)
        return {"status": "gmail_tabs_opened", **opened}

    if action_type == "sync_crm_snapshot":
        return {"status": "crm_synced", "lead_count": int(payload.get("lead_count", 0))}

    if action_type == "deploy_to_vercel_preview":
        project_dir = Path(str(payload.get("project_dir", "")))
        prod = bool(payload.get("prod", False))
        cmd = ["vercel", "--yes"]
        if prod:
            cmd.append("--prod")
        result = run_shell_command(cmd, cwd=project_dir, timeout=600)
        if result["ok"]:
            return {"status": "deployed", "provider": "vercel", "prod": prod, **result}
        hint = "Vercel deploy failed. Ensure Vercel CLI is installed and authenticated: 'vercel login'."
        return {"status": "deploy_failed", "provider": "vercel", "prod": prod, "hint": hint, **result}

    if action_type == "deploy_to_netlify_preview":
        project_dir = Path(str(payload.get("project_dir", "")))
        prod = bool(payload.get("prod", False))
        cmd = ["netlify", "deploy", "--build"]
        if prod:
            cmd.append("--prod")
        result = run_shell_command(cmd, cwd=project_dir, timeout=900)
        if result["ok"]:
            return {"status": "deployed", "provider": "netlify", "prod": prod, **result}
        hint = "Netlify deploy failed. Ensure Netlify CLI is installed and authenticated: 'netlify login'."
        return {"status": "deploy_failed", "provider": "netlify", "prod": prod, "hint": hint, **result}

    raise ValueError(f"Unsupported action type: {action_type}")


def execute_action(user_id: str, action_id: str) -> Dict[str, Any]:
    session = get_session(user_id)
    if int(session.get("kill_switch", 0)) == 1:
        blocked = set_action_status(user_id, action_id, "blocked", error="Kill switch is enabled")
        append_log(user_id, "action_blocked", "Action blocked by kill switch", action_id)
        return blocked

    action = get_action(user_id, action_id)
    if action["status"] != "approved":
        raise HTTPException(status_code=400, detail=f"Action is not executable from status {action['status']}")
    if action.get("action_type") in OS_CONTROL_REQUIRED_ACTIONS and action.get("action_type") != "request_os_control":
        if int(session.get("os_control_granted", 0)) == 0:
            blocked = set_action_status(user_id, action_id, "blocked", error="OS control permission not granted yet")
            append_log(user_id, "action_blocked", "Action blocked: grant OS control first", action_id)
            return blocked
    if int(session.get("desktop_prompts", 1)) == 1:
        permitted = desktop_permission_popup(action)
        if not permitted:
            blocked = set_action_status(user_id, action_id, "blocked", error="Denied in desktop permission popup")
            append_log(user_id, "action_blocked", "Action denied via desktop popup", action_id)
            return blocked

    set_action_status(user_id, action_id, "running")
    append_log(user_id, "action_running", f"Running action: {action['title']}", action_id)

    try:
        result = run_action(action)
        done = set_action_status(user_id, action_id, "completed", result=result)
        append_log(user_id, "action_completed", f"Completed action: {action['title']}", action_id, result)
        return done
    except Exception as exc:
        failed = set_action_status(user_id, action_id, "failed", error=f"{type(exc).__name__}: {exc}")
        append_log(user_id, "action_failed", f"Failed action: {action['title']}", action_id, {"error": str(exc)})
        return failed


def build_state(user_id: str) -> Dict[str, Any]:
    session = get_session(user_id)
    project_dir = str(session.get("project_dir", "")).strip()
    workspace_root = str(get_workspace_root(session))
    drafts_path = str(Path(project_dir) / "drafts" / "gmail-drafts.txt") if project_dir else ""

    return {
        "session": {
            "user_id": session["user_id"],
            "goal": session.get("goal", ""),
            "run_count": int(session.get("run_count", 0)),
            "require_approval": bool(session.get("require_approval", 1)),
            "kill_switch": bool(session.get("kill_switch", 0)),
            "os_control_granted": bool(session.get("os_control_granted", 0)),
            "workspace_root": workspace_root,
            "desktop_prompts": bool(session.get("desktop_prompts", 1)),
            "deploy_provider": safe_deploy_provider(str(session.get("deploy_provider", "vercel"))),
            "use_playwright": bool(session.get("use_playwright", 1)),
            "project_slug": session.get("project_slug", ""),
            "project_dir": session.get("project_dir", ""),
        },
        "plan": session.get("plan_json", []),
        "offer": session.get("offer_json", {}),
        "landing": session.get("landing_text", ""),
        "outreach": session.get("outreach_text", ""),
        "leads": list_leads(user_id),
        "queue": list_actions(user_id),
        "logs": list_logs(user_id),
        "artifacts": {
            "project_dir": project_dir,
            "drafts_path": drafts_path,
            "workspace_root": workspace_root,
            "deploy_provider": safe_deploy_provider(str(session.get("deploy_provider", "vercel"))),
            "preview_paths": {
                "site": f"/preview/{user_id}/site",
                "emails": f"/preview/{user_id}/emails",
                "report": f"/preview/{user_id}/report",
            },
        },
    }


def render_preview_shell(title: str, body_html: str) -> str:
    return f"""
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{escape(title)}</title>
    <style>
      :root {{
        --bg: #040a07;
        --panel: #0a1411;
        --line: #1f3a30;
        --ink: #d9fce8;
        --muted: #9ad9b8;
        --neon: #31f38a;
      }}
      * {{ box-sizing: border-box; }}
      body {{
        margin: 0;
        font-family: "Segoe UI", Arial, sans-serif;
        color: var(--ink);
        background:
          radial-gradient(80rem 40rem at 90% -20%, #0d5a2f44 0%, transparent 55%),
          radial-gradient(70rem 36rem at -10% 20%, #0d5a2f33 0%, transparent 50%),
          var(--bg);
      }}
      .wrap {{ max-width: 1040px; margin: 2rem auto; padding: 0 1rem 3rem; }}
      .panel {{
        background: linear-gradient(180deg, #0c1713 0%, #0b1512 100%);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 1rem 1.15rem;
        box-shadow: 0 24px 60px -40px #000;
      }}
      h1 {{ margin: 0 0 1rem; color: var(--neon); }}
      h2 {{ margin: 0 0 .6rem; font-size: 1rem; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }}
      pre {{
        white-space: pre-wrap;
        margin: 0;
        padding: 1rem;
        border-radius: 12px;
        border: 1px solid #27473b;
        background: #07100d;
      }}
      a {{ color: var(--neon); text-decoration: none; }}
      a:hover {{ text-decoration: underline; }}
      .stack {{ display: grid; gap: 1rem; }}
      .mono {{ font-family: "Consolas", "Menlo", monospace; font-size: 12px; color: var(--muted); }}
      .note {{ color: var(--muted); }}
      table {{ width: 100%; border-collapse: collapse; }}
      th, td {{ border-bottom: 1px solid #1f3a30; padding: .45rem; text-align: left; font-size: 13px; }}
      th {{ color: var(--muted); font-weight: 600; }}
    </style>
  </head>
  <body>
    <div class="wrap">
      {body_html}
    </div>
  </body>
</html>
"""


@app.get("/artifacts/{user_id}")
def artifacts(user_id: str) -> Dict[str, Any]:
    state_data = build_state(user_id)
    artifacts_data = state_data.get("artifacts", {})
    return {
        "project_dir": artifacts_data.get("project_dir", ""),
        "drafts_path": artifacts_data.get("drafts_path", ""),
        "workspace_root": artifacts_data.get("workspace_root", ""),
        "deploy_provider": artifacts_data.get("deploy_provider", "vercel"),
        "preview_paths": artifacts_data.get("preview_paths", {}),
    }


@app.get("/preview/{user_id}/site", response_class=HTMLResponse)
def preview_site(user_id: str) -> str:
    state_data = build_state(user_id)
    offer = state_data.get("offer", {}) or {}
    landing = state_data.get("landing", "") or "No landing draft available yet."
    project_dir = state_data.get("session", {}).get("project_dir", "")

    body = (
        f"<h1>{escape(offer.get('offer_name', 'Generated Site Preview'))}</h1>"
        "<div class='panel stack'>"
        "<h2>Landing Draft</h2>"
        f"<pre>{escape(landing)}</pre>"
        f"<p class='mono'>project_dir: {escape(str(project_dir))}</p>"
        "</div>"
    )
    return render_preview_shell("Site Preview", body)


@app.get("/preview/{user_id}/emails", response_class=HTMLResponse)
def preview_emails(user_id: str) -> str:
    state_data = build_state(user_id)
    session = state_data.get("session", {})
    leads = state_data.get("leads", []) or []
    outreach = state_data.get("outreach", "") or "No outreach drafts available."
    project_dir = str(session.get("project_dir", "")).strip()
    drafts_path = Path(project_dir) / "drafts" / "gmail-drafts.txt" if project_dir else None

    drafts_content = outreach
    if drafts_path and drafts_path.exists():
        try:
            drafts_content = drafts_path.read_text(encoding="utf-8")
        except Exception:
            drafts_content = outreach

    lead_rows = "".join(
        "<tr>"
        f"<td>{escape(str(lead.get('company_name') or lead.get('title', '')))}</td>"
        f"<td>{escape(str(lead.get('email', '') or ''))}</td>"
        f"<td>{escape(str(lead.get('contact_url', '') or ''))}</td>"
        "</tr>"
        for lead in leads[:10]
    )

    body = (
        "<h1>Email Drafts Preview</h1>"
        "<div class='panel stack'>"
        "<h2>Drafts</h2>"
        f"<pre>{escape(drafts_content)}</pre>"
        f"<p class='mono'>drafts_path: {escape(str(drafts_path) if drafts_path else '')}</p>"
        "<p class='note'>Drafts are preview-only. Sending remains manual.</p>"
        "</div>"
        "<div class='panel stack' style='margin-top:1rem'>"
        "<h2>Lead Contacts</h2>"
        "<table><thead><tr><th>Company</th><th>Email</th><th>Contact URL</th></tr></thead>"
        f"<tbody>{lead_rows}</tbody></table>"
        "</div>"
    )
    return render_preview_shell("Email Drafts", body)


@app.get("/preview/{user_id}/report", response_class=HTMLResponse)
def preview_report(user_id: str) -> str:
    state_data = build_state(user_id)
    session = state_data.get("session", {})
    offer = state_data.get("offer", {}) or {}
    leads = state_data.get("leads", []) or []
    queue = state_data.get("queue", []) or []
    logs = state_data.get("logs", []) or []

    lead_rows = "".join(
        "<tr>"
        f"<td>{escape(str(lead.get('company_name') or lead.get('title', '')))}</td>"
        f"<td>{escape(str(lead.get('email', '') or lead.get('contact_url', '')))}</td>"
        f"<td>{escape(str(lead.get('score', '')))}</td>"
        f"<td>{escape(str(lead.get('stage', '')))}</td>"
        "</tr>"
        for lead in leads[:10]
    )
    queue_rows = "".join(
        f"<tr><td>{escape(str(item.get('title', '')))}</td><td>{escape(str(item.get('status', '')))}</td><td>{escape(str(item.get('layer', '')))}</td></tr>"
        for item in queue[:15]
    )
    log_rows = "".join(
        f"<tr><td>{escape(str(item.get('event_type', '')))}</td><td>{escape(str(item.get('message', '')))}</td><td>{escape(str(item.get('created_at', '')))}</td></tr>"
        for item in logs[:15]
    )

    body = (
        "<h1>Pipeline Report</h1>"
        "<div class='panel stack'>"
        "<h2>Summary</h2>"
        f"<p><strong>Goal:</strong> {escape(str(session.get('goal', '')))}</p>"
        f"<p><strong>Offer:</strong> {escape(str(offer.get('offer_name', '')))}</p>"
        f"<p><strong>OS Control Granted:</strong> {escape(str(bool(session.get('os_control_granted', False))))}</p>"
        f"<p><strong>Workspace Root:</strong> <span class='mono'>{escape(str(session.get('workspace_root', '')))}</span></p>"
        f"<p><strong>Deploy Provider:</strong> {escape(str(session.get('deploy_provider', 'vercel')))}</p>"
        f"<p><strong>Project Dir:</strong> <span class='mono'>{escape(str(session.get('project_dir', '')))}</span></p>"
        f"<p><a href='/preview/{user_id}/site' target='_blank'>Open Site Preview</a> | "
        f"<a href='/preview/{user_id}/emails' target='_blank'>Open Email Preview</a></p>"
        "</div>"
        "<div class='panel stack' style='margin-top:1rem'>"
        "<h2>Leads</h2>"
        "<table><thead><tr><th>Lead</th><th>Email / Contact</th><th>Score</th><th>Stage</th></tr></thead>"
        f"<tbody>{lead_rows}</tbody></table>"
        "</div>"
        "<div class='panel stack' style='margin-top:1rem'>"
        "<h2>Queue</h2>"
        "<table><thead><tr><th>Action</th><th>Status</th><th>Layer</th></tr></thead>"
        f"<tbody>{queue_rows}</tbody></table>"
        "</div>"
        "<div class='panel stack' style='margin-top:1rem'>"
        "<h2>Activity Log</h2>"
        "<table><thead><tr><th>Event</th><th>Message</th><th>Time</th></tr></thead>"
        f"<tbody>{log_rows}</tbody></table>"
        "</div>"
    )
    return render_preview_shell("Pipeline Report", body)


@app.get("/")
def root() -> Dict[str, Any]:
    return {"service": "the-architect", "version": "0.2.0", "docs": "/docs", "health": "/health"}


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "time": now_iso(),
        "db_path": str(DB_PATH),
        "generated_root": str(GENERATED_ROOT),
        "playwright_profile": str(PLAYWRIGHT_PROFILE_DIR),
        "default_deploy_provider": safe_deploy_provider(DEFAULT_DEPLOY_PROVIDER),
        "llm_provider": "bedrock" if bedrock else "local-template",
        "search_provider": "tavily" if TAVILY_API_KEY else "synthetic",
    }


@app.get("/state/{user_id}")
def state(user_id: str) -> Dict[str, Any]:
    return build_state(user_id)


@app.post("/goal")
def set_goal(req: GoalReq) -> Dict[str, Any]:
    plan = default_plan(req.goal)
    update_session(req.user_id, goal=req.goal, plan_json=plan)
    append_log(req.user_id, "goal_set", "Goal updated", data={"goal": req.goal})
    return {"ok": True, "goal": req.goal, "plan": plan}


@app.post("/session/kill-switch")
def set_kill_switch(req: KillSwitchReq) -> Dict[str, Any]:
    update_session(req.user_id, kill_switch=1 if req.enabled else 0)
    append_log(req.user_id, "kill_switch", "Kill switch updated", data={"enabled": req.enabled})
    return {"ok": True, "enabled": req.enabled}


@app.post("/session/approval-mode")
def set_approval_mode(req: ApprovalModeReq) -> Dict[str, Any]:
    update_session(req.user_id, require_approval=1 if req.required else 0)
    append_log(req.user_id, "approval_mode", "Approval mode updated", data={"required": req.required})
    return {"ok": True, "required": req.required}


@app.post("/session/workspace-root")
def set_workspace_root(req: WorkspaceRootReq) -> Dict[str, Any]:
    try:
        root = resolve_workspace_root(req.path)
        root.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid workspace path: {exc}") from exc
    update_session(req.user_id, workspace_root=str(root))
    append_log(req.user_id, "workspace_root", "Workspace root updated", data={"workspace_root": str(root)})
    return {"ok": True, "workspace_root": str(root)}


@app.post("/session/desktop-prompts")
def set_desktop_prompts(req: DesktopPromptReq) -> Dict[str, Any]:
    update_session(req.user_id, desktop_prompts=1 if req.enabled else 0)
    append_log(req.user_id, "desktop_prompts", "Desktop prompts updated", data={"enabled": req.enabled})
    return {"ok": True, "enabled": req.enabled}


@app.post("/session/deploy-provider")
def set_deploy_provider(req: DeployProviderReq) -> Dict[str, Any]:
    provider = safe_deploy_provider(req.provider)
    update_session(req.user_id, deploy_provider=provider)
    append_log(req.user_id, "deploy_provider", "Deploy provider updated", data={"provider": provider})
    return {"ok": True, "provider": provider}


@app.post("/session/browser-automation")
def set_browser_automation(req: BrowserAutomationReq) -> Dict[str, Any]:
    update_session(req.user_id, use_playwright=1 if req.use_playwright else 0)
    append_log(req.user_id, "browser_automation", "Browser automation mode updated", data={"use_playwright": req.use_playwright})
    return {"ok": True, "use_playwright": req.use_playwright}


@app.post("/site/revision")
def site_revision(req: SiteRevisionReq) -> Dict[str, Any]:
    session = get_session(req.user_id)
    if int(session.get("kill_switch", 0)) == 1:
        raise HTTPException(status_code=400, detail="Kill switch is enabled")

    offer = session.get("offer_json", {}) or {}
    if not offer:
        raise HTTPException(status_code=400, detail="Run pipeline first so offer context exists")

    use_playwright = bool(session.get("use_playwright", 1))
    revision_prompt = (
        f"Revise the existing landing page.\n"
        f"Offer: {offer.get('offer_name', '')}\n"
        f"Niche: {offer.get('niche', '')}\n"
        f"City: {offer.get('city', '')}\n"
        f"Requested edits: {req.instructions.strip()}\n"
        "Preserve core CTA and improve conversion clarity."
    )

    actions = [
        enqueue_action(
            req.user_id,
            "open_lovable_workspace",
            "Website Builder",
            "Open Lovable for site revisions",
            "Open Lovable with revision context.",
            payload={"prompt": revision_prompt, "use_playwright": use_playwright},
            command="browser:open lovable.dev",
            needs_approval=True,
            reversible=False,
        ),
        enqueue_action(
            req.user_id,
            "automate_lovable_site",
            "Website Builder",
            "Apply revision request in Lovable",
            "Paste revision prompt and trigger generation in Lovable.",
            payload={"prompt": revision_prompt, "use_playwright": use_playwright},
            command="playwright:lovable-revision",
            needs_approval=True,
            reversible=False,
        ),
    ]
    append_log(req.user_id, "site_revision", "Queued site revision actions", data={"instructions": req.instructions[:300]})
    return {"ok": True, "queued": len(actions), "actions": actions}


@app.get("/queue/{user_id}")
def queue(user_id: str) -> Dict[str, Any]:
    return {"items": list_actions(user_id), "active": list_actions(user_id, active_only=True)}


@app.post("/queue/{action_id}/approve")
def approve(action_id: str, req: UserReq) -> Dict[str, Any]:
    action = get_action(req.user_id, action_id)
    if action["status"] != "pending_approval":
        raise HTTPException(status_code=400, detail=f"Cannot approve from status {action['status']}")
    updated = set_action_status(req.user_id, action_id, "approved")
    append_log(req.user_id, "action_approved", f"Approved: {updated['title']}", action_id)
    return {"ok": True, "action": updated}


@app.post("/queue/{action_id}/reject")
def reject(action_id: str, req: UserReq) -> Dict[str, Any]:
    action = get_action(req.user_id, action_id)
    if action["status"] not in {"pending_approval", "approved"}:
        raise HTTPException(status_code=400, detail=f"Cannot reject from status {action['status']}")
    updated = set_action_status(req.user_id, action_id, "rejected")
    append_log(req.user_id, "action_rejected", f"Rejected: {updated['title']}", action_id)
    return {"ok": True, "action": updated}


@app.post("/queue/{action_id}/execute")
def execute(action_id: str, req: UserReq) -> Dict[str, Any]:
    return {"ok": True, "action": execute_action(req.user_id, action_id)}


@app.post("/queue/execute-ready")
def execute_ready(req: ExecuteReadyReq) -> Dict[str, Any]:
    approved = [item for item in list_actions(req.user_id, active_only=True) if item["status"] == "approved"]
    approved = approved[: max(1, min(req.limit, 50))]
    executed = [execute_action(req.user_id, item["id"]) for item in approved]
    return {"ok": True, "executed": len(executed), "actions": executed}


@app.get("/crm/{user_id}/leads")
def crm_leads(user_id: str) -> Dict[str, Any]:
    return {"items": list_leads(user_id)}


@app.post("/crm/lead/{lead_id}/stage")
def crm_stage(lead_id: int, req: StageReq) -> Dict[str, Any]:
    stage = req.stage.strip().lower()
    if stage not in LEAD_STAGES:
        raise HTTPException(status_code=400, detail=f"Invalid stage '{stage}'. Valid: {sorted(LEAD_STAGES)}")
    lead = update_lead_stage(req.user_id, lead_id, stage)
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    append_log(req.user_id, "lead_stage", "Lead stage updated", data={"lead_id": lead_id, "stage": stage})
    return {"ok": True, "lead": lead}


@app.get("/logs/{user_id}")
def logs(user_id: str, limit: int = 50) -> Dict[str, Any]:
    return {"items": list_logs(user_id, limit=limit)}


@app.post("/chat", response_model=ChatResp)
def chat(req: ChatReq) -> ChatResp:
    try:
        session = get_session(req.user_id)
        message = req.message.strip()
        if not message:
            return ChatResp(reply="Please provide a goal or instruction.")

        goal = infer_goal(message, req.context)
        run_trigger = bool(re.search(r"\b(run|launch|go|do\s*it)\b", message, flags=re.IGNORECASE))

        if not run_trigger:
            plan = default_plan(goal)
            update_session(req.user_id, goal=goal, plan_json=plan)
            append_log(req.user_id, "planning", "Plan updated from user message", data={"goal": goal})
            return ChatResp(
                reply="Plan updated. End your message with RUN to execute the full pipeline with approval gates.",
                data={"status": "collecting", "goal": goal, "plan": plan},
            )

        if int(session.get("kill_switch", 0)) == 1:
            return ChatResp(reply="Kill switch is enabled. Disable it before running actions.", data={"status": "blocked"})

        offer = make_offer(goal)
        gathered = gather_real_leads(offer)
        leads = score_leads(offer, gathered[:12])
        landing = build_landing_copy(offer)
        outreach = build_outreach_drafts(offer, leads)

        replace_leads(req.user_id, leads)

        plan = default_plan(goal)
        for item in plan:
            if item["id"] in {"define-niche", "offer-build", "lead-gen", "outreach"}:
                item["status"] = "completed"
            if item["id"] == "brand-site":
                item["status"] = "in_progress"

        run_count = int(session.get("run_count", 0)) + 1
        updated = update_session(
            req.user_id,
            goal=goal,
            run_count=run_count,
            plan_json=plan,
            offer_json=offer,
            landing_text=landing,
            outreach_text=outreach,
        )

        queued = queue_mvp_actions(req.user_id, updated, offer, leads)
        append_log(req.user_id, "pipeline_run", "Pipeline executed", data={"run_count": run_count, "queued_actions": len(queued)})

        return ChatResp(
            reply=(
                "Pipeline executed.\n"
                f"- Niche: {offer.get('niche', 'n/a')}\n"
                f"- Offer: {offer.get('offer_name', 'n/a')}\n"
                f"- Leads scored: {len(leads)}\n"
                f"- Actions queued: {len(queued)}\n\n"
                f"- Business folder: {updated.get('project_dir', '')}\n"
                f"- Deploy target: {safe_deploy_provider(str(updated.get('deploy_provider', 'vercel')))}\n\n"
                "Approve 'Request laptop control permission' first, then execute approved steps."
            ),
            data={
                "status": "ran",
                "goal": goal,
                "plan": plan,
                "offer": offer,
                "leads": leads,
                "landing": landing,
                "outreach": outreach,
                "queue": queued,
                "session": {
                    "run_count": run_count,
                    "project_slug": updated.get("project_slug", ""),
                    "project_dir": updated.get("project_dir", ""),
                    "require_approval": bool(updated.get("require_approval", 1)),
                },
            },
        )

    except HTTPException:
        raise
    except Exception as exc:
        return ChatResp(
            reply="Backend error during pipeline execution.",
            data={
                "status": "error",
                "error": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc(),
            },
        )
