// ── Demo Relay Control — Cloudflare Worker ────────────────────────────────────
// POST /              — proxy relay command to Notehub as data.qi
// POST /ingest        — receive Notehub webhook, parse LC or LC Response
// POST /env           — set Notehub environment variables (avoids CORS)

const NOTEHUB_TOKEN = "api_key_ghn9PnVbcab9VdToEGJuPfKVZXk9wlF9vpP+5e60sMA=";
const PROJECT_UID   = "app:45e8c741-8358-4e04-b03a-b5f39135702a";
const DEVICE_UID    = "dev:868032061489682";

const SUPABASE_URL         = "https://lqisreketpdzhpqjcqke.supabase.co";
// IMPORTANT: Replace with your actual service role key from Supabase → Settings → API
// In production, store this as a Cloudflare Worker Secret, not hardcoded
// SUPABASE_SERVICE_KEY is stored as a Cloudflare Worker Secret (not hardcoded)
// Set it via: Cloudflare Dashboard → Workers → patient-shadow → Settings → Variables → Add Secret
// Name: SUPABASE_SERVICE_KEY  Value: your-service-role-key-from-supabase
const SUPABASE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxaXNyZWtldHBkemhwcWpjcWtlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5OTM3OTAsImV4cCI6MjA5MzU2OTc5MH0.dHTih6XYSFbtMrljcb3SYtORTzxM8QVcx1i38x0izTo";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Device-UID, Authorization"
};

// ── LC Status Labels ──────────────────────────────────────────────────────────
const LC_STATUS_LABELS = {
  0: "Event Received",   1: "Event Started",      2: "Event Ended",
  3: "Already In Queue", 4: "Rejected-Queue Full", 5: "Rejected",
  6: "Event Canceled",   7: "Override",            8: "Override Canceled",
  9: "Comfort Override", 10:"Comfort Exit"
};

// ── LC Response Parser (20-char hex) ─────────────────────────────────────────
function parseLCResponse(hex) {
  hex = hex.trim().toUpperCase();
  if (hex.length !== 20) return null;
  const b = (pos) => parseInt(hex.slice(pos*2, pos*2+2), 16);
  if (b(0) !== 0x51 || b(2) !== 0x00) return null;
  const eventId   = b(3);
  const statusNum = b(4) & 0x0F;
  const timestamp = (b(5)<<24)|(b(6)<<16)|(b(7)<<8)|b(8);
  const checksum  = b(9);
  let xor = 0;
  for (let i = 0; i < 9; i++) xor ^= b(i);
  return { eventId, statusNum, statusLabel: LC_STATUS_LABELS[statusNum]||"Unknown", timestamp, checksumOk: xor===checksum };
}

// ── Bubble Up Parser (62-char hex) ───────────────────────────────────────────
function parseBubbleUp(hex) {
  hex = hex.trim().toUpperCase();
  if (hex.length !== 62) throw new Error(`Expected 62 chars, got ${hex.length}`);
  const b = (pos) => parseInt(hex.slice(pos*2, pos*2+2), 16);
  const w = (a, b2) => (b(a)<<8)|b(b2);
  return {
    header_byte:           b(0),  message_length:        b(1),
    message_type:          b(2),  bubble_up_config:       b(3),
    bubble_up_config_main: b(4),  relay_status_r1:        b(5),
    relay_status_r2:       b(6),  relay_status_r3:        b(7),
    relay_status_r4:       b(8),  power_up_flag:          b(9),
    customer_comfort:      b(10), voltage:                w(11,12),
    current:               w(13,14), power_factor:        w(15,16),
    watts_consumed:        w(17,18), touch_pad_command:   b(19),
    sw_value:              w(20,21), sq_value:            w(22,23),
    override_timer_value:  w(24,25),
    serial_number:         (b(26)<<16)|(b(27)<<8)|b(28),
    device_identifier:     b(29), validation_code:        b(30)
  };
}

async function supabasePost(path, data) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json", "Prefer": "return=minimal"
    },
    body: JSON.stringify(data)
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST" && request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    console.log("Worker received:", request.method, url.pathname);
    let body = {};
    if (request.method === "POST") {
      try { body = await request.json(); } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
    }

    // ── /env — set Notehub environment variables ──────────────────────────────
    // Proxies env var requests to avoid CORS from browser
    if (url.pathname === "/env" || url.pathname === "/env/") {
      const deviceUID = body.deviceUID || DEVICE_UID;
      const envVars   = body.environment_variables || {};
      const method    = body.method || "PUT"; // PUT=set, DELETE=clear

      const notehubURL = `https://api.notefile.net/v1/projects/${PROJECT_UID}/devices/${encodeURIComponent(deviceUID)}/environment_variables`;

      try {
        const res = await fetch(notehubURL, {
          method,
          headers: {
            "Authorization": `Bearer ${NOTEHUB_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: method !== "DELETE" ? JSON.stringify({ environment_variables: envVars }) : undefined
        });
        const text = await res.text();
        return new Response(text, {
          status: res.status,
          headers: { ...CORS, "Content-Type": "application/json" }
        });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { ...CORS, "Content-Type": "application/json" }
        });
      }
    }

    // ── /env/get — get Notehub environment variables ──────────────────────────
    if (url.pathname === "/env/get" || url.pathname === "/env/get/") {
      const deviceUID = body.deviceUID || DEVICE_UID;
      const notehubURL = `https://api.notefile.net/v1/projects/${PROJECT_UID}/devices/${encodeURIComponent(deviceUID)}/environment_variables`;
      try {
        const res = await fetch(notehubURL, {
          headers: { "Authorization": `Bearer ${NOTEHUB_TOKEN}` }
        });
        const text = await res.text();
        return new Response(text, {
          status: res.status,
          headers: { ...CORS, "Content-Type": "application/json" }
        });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { ...CORS, "Content-Type": "application/json" }
        });
      }
    }

    // ── /admin/create-user — create Supabase user (requires admin JWT) ─────────
    if (url.pathname === "/admin/create-user" || url.pathname === "/admin/create-user/") {
      // Verify the caller has a valid JWT
      const authHeader = request.headers.get("Authorization") || "";
      const callerJWT  = authHeader.replace("Bearer ", "");
      if (!callerJWT) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...CORS, "Content-Type": "application/json" }
        });
      }

      // Verify caller is an administrator
      const verifyRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?select=role`,
        { headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${callerJWT}` } }
      );
      const profiles = await verifyRes.json();
      const callerRole = profiles?.[0]?.role;
      if (callerRole !== "administrator") {
        return new Response(JSON.stringify({ error: "Administrator access required" }), {
          status: 403, headers: { ...CORS, "Content-Type": "application/json" }
        });
      }

      if (!env.SUPABASE_SERVICE_KEY) {
        return new Response(JSON.stringify({ error: "Service key not configured in Worker secrets" }), {
          status: 500, headers: { ...CORS, "Content-Type": "application/json" }
        });
      }

      const { email, password, name, role, two_fa_required } = body;
      if (!email || !password || !role) {
        return new Response(JSON.stringify({ error: "email, password and role required" }), {
          status: 400, headers: { ...CORS, "Content-Type": "application/json" }
        });
      }

      // Create user via Supabase Admin API using service role
      // Note: We use the anon key here — in production use service role key stored as Worker secret
      const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: name }
        })
      });

      if (!createRes.ok) {
        const err = await createRes.text();
        return new Response(err, { status: createRes.status, headers: { ...CORS, "Content-Type": "application/json" } });
      }

      const newUser = await createRes.json();

      // Insert profile
      const profileInsert = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        },
        body: JSON.stringify({
          id:               newUser.id,
          email,
          full_name:        name || "",
          role,
          two_fa_required:  two_fa_required || false,
          is_active:        true
        })
      });

      if (!profileInsert.ok) {
        const err = await profileInsert.text();
        return new Response(JSON.stringify({ error: "User created but profile failed: " + err }), {
          status: 500, headers: { ...CORS, "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ success: true, userId: newUser.id }), {
        status: 200, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    // ── /session — _session.qo health data ──────────────────────────────────────
    if (url.pathname === "/session" || url.pathname === "/session/") {
      const device_uid = body?.device ?? body?.uid ?? "unknown";

      // Parse firmware version from JSON string
      let firmware_version = null;
      try {
        const fw = typeof body?.firmware_notecard === "string"
          ? JSON.parse(body.firmware_notecard)
          : body?.firmware_notecard;
        firmware_version = fw?.version || null;
      } catch(e) {}

      const record = {
        device_uid,
        recorded_at:    new Date().toISOString(),
        voltage:        body?.voltage        ?? null,
        temperature:    body?.temp           ?? null,
        rsrp:           body?.rsrp           ?? null,
        rsrq:           body?.rsrq           ?? null,
        rssi:           body?.rssi           ?? null,
        sinr:           body?.sinr           ?? null,
        bars:           body?.bars           ?? null,
        rat:            body?.rat            ?? null,
        bearer:         body?.bearer         ?? null,
        moved:          body?.moved          ?? null,
        orientation:    body?.orientation    ?? null,
        session_reason: body?.body?.why      ?? null,
        firmware_version,
        lat:            body?.best_lat       ?? body?.tower_lat      ?? null,
        lon:            body?.best_lon       ?? body?.tower_lon      ?? null,
        location:       body?.best_location  ?? body?.tower_location ?? null,
        raw:            body
      };

      const dbRes = await supabasePost("device_health", record);
      if (!dbRes.ok) {
        const err = await dbRes.text();
        console.error("device_health insert failed:", err);
        return new Response(JSON.stringify({ success: false, error: err }), {
          status: 500, headers: { ...CORS, "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ success: true, device_uid }), {
        status: 200, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    // ── /ingest — Notehub webhook ─────────────────────────────────────────────
    if (url.pathname === "/ingest" || url.pathname === "/ingest/") {
      const device_uid = body?.device ?? body?.uid ?? "unknown";
      const file = body?.file || "";
      // ── Route system notefiles to device_health ──────────────────────────────
      // Only process session.begin (has full health data) and _health.qo
      // Skip session.end — it overwrites good data with nulls
      const isSessionBegin = file === "_session.qo" && body?.req === "session.begin";
      const isHealthFile   = file === "_health.qo" || file === "_health_host.qo";
      if (isSessionBegin || isHealthFile) {
        let firmware_version = null;
        try {
          const fw = typeof body?.firmware_notecard === "string"
            ? JSON.parse(body.firmware_notecard) : body?.firmware_notecard;
          firmware_version = fw?.version || null;
        } catch(e) {}
        const voltage     = body?.voltage ?? body?.body?.voltage ?? null;
        const temperature = body?.temp    ?? body?.body?.temp    ?? null;
        const rat         = body?.rat ?? (body?.transport ? body.transport.split(":")[1] : null);
        const healthRecord = {
          device_uid, recorded_at: new Date().toISOString(),
          voltage, temperature,
          rsrp:     body?.rsrp    ?? null,
          rsrq:     body?.rsrq    ?? null,
          rssi:     body?.rssi    ?? null,
          sinr:     body?.sinr    ?? null,
          bars:     body?.bars    ?? null,
          rat, bearer: body?.bearer ?? null,
          moved:          body?.moved       ?? null,
          orientation:    body?.orientation ?? null,
          session_reason: body?.body?.why   ?? body?.body?.text ?? null,
          firmware_version,
          lat:      body?.best_lat      ?? body?.tower_lat      ?? null,
          lon:      body?.best_lon      ?? body?.tower_lon      ?? null,
          location: body?.best_location ?? body?.tower_location ?? null,
          raw: body
        };
        const hRes = await supabasePost("device_health", healthRecord);
        return new Response(JSON.stringify({ success: hRes.ok, device_uid, file }), {
          status: hRes.ok ? 200 : 500, headers: { ...CORS, "Content-Type": "application/json" }
        });
      }

      // Skip session.end and other system notefiles gracefully
      if (file.startsWith("_")) {
        return new Response(JSON.stringify({ success: true, skipped: true, file }), {
          status: 200, headers: { ...CORS, "Content-Type": "application/json" }
        });
      }

      const lc    = body?.body?.LC;
      const lcLen = lc ? lc.trim().length : 0;

      // ── LC Response (20 chars) → device_events ─────────────────────────────
      if (lcLen === 20) {
        const parsed = parseLCResponse(lc);
        if (!parsed) {
          return new Response(JSON.stringify({ error: "Invalid LC Response" }), {
            status: 400, headers: { ...CORS, "Content-Type": "application/json" }
          });
        }
        const evRes = await supabasePost("device_events", {
          device_uid, event_id: parsed.eventId,
          lc_status: parsed.statusNum, lc_status_label: parsed.statusLabel,
          timestamp_unix: parsed.timestamp,
          event_time: parsed.timestamp > 0 ? new Date(parsed.timestamp*1000).toISOString() : new Date().toISOString(),
          raw_hex: lc, checksum_ok: parsed.checksumOk,
          received_at: new Date().toISOString()
        });
        return new Response(JSON.stringify({
          success: evRes.ok, device_uid,
          event_id: parsed.eventId, status: parsed.statusLabel
        }), { status: evRes.ok?200:500, headers: { ...CORS, "Content-Type": "application/json" } });
      }

      // ── Bubble Up (62 chars) → device_readings (deduplicated) ───────────────
      if (lcLen === 62) {
        let parsed;
        try { parsed = parseBubbleUp(lc); } catch(e) {
          return new Response(JSON.stringify({ error: e.message }), {
            status: 400, headers: { ...CORS, "Content-Type": "application/json" }
          });
        }

        const recordedAt = body?.when
          ? new Date(body.when*1000).toISOString()
          : new Date().toISOString();

        // Deduplication: check if identical raw_lc was recorded in last 60 seconds
        const dedupWindow = new Date(Date.now() - 60000).toISOString();
        let isDuplicate = false;
        try {
          const existing = await fetch(
            `${SUPABASE_URL}/rest/v1/device_readings?device_uid=eq.${encodeURIComponent(device_uid)}&raw_lc=eq.${encodeURIComponent(lc)}&recorded_at=gte.${dedupWindow}&limit=1`,
            { headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } }
          );
          if (existing.ok) {
            const existingData = await existing.json();
            isDuplicate = Array.isArray(existingData) && existingData.length > 0;
          }
        } catch(e) { console.error("Dedup check failed:", e.message); }
        if (isDuplicate) {
          return new Response(JSON.stringify({ success: true, deduplicated: true, device_uid }), {
            status: 200, headers: { ...CORS, "Content-Type": "application/json" }
          });
        }

        const record = {
          ...parsed, device_uid, raw_lc: lc, recorded_at: recordedAt,
          lat:      body?.best_lat      ?? body?.tower_lat      ?? null,
          lon:      body?.best_lon      ?? body?.tower_lon      ?? null,
          location: body?.best_location ?? body?.tower_location ?? null,
          country:  body?.best_country  ?? body?.tower_country  ?? null,
        };
        const dbRes = await supabasePost("device_readings", record);
        if (!dbRes.ok) {
          const errText = await dbRes.text();
          console.error("device_readings insert failed:", errText);
          return new Response(JSON.stringify({ success: false, device_uid, error: errText }), {
            status: 500, headers: { ...CORS, "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ success: true, device_uid }), {
          status: 200, headers: { ...CORS, "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ error: "Unexpected LC length", lcLen }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    // ── / (root) — relay command proxy → Notehub ──────────────────────────────
    // Only handle root path for relay commands
    if (url.pathname !== "/" && url.pathname !== "") {
      return new Response(JSON.stringify({ error: "Unknown path", pathname: url.pathname }), {
        status: 404, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }
    const deviceUID  = request.headers.get("X-Device-UID") || DEVICE_UID;
    const notehubURL = `https://api.notefile.net/v1/projects/${PROJECT_UID}/devices/${encodeURIComponent(deviceUID)}/notes/data.qi`;
    const res = await fetch(notehubURL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${NOTEHUB_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body })
    });
    const result = await res.text();
    return new Response(result, {
      status: res.status, headers: { ...CORS, "Content-Type": "application/json" }
    });
  }
};
