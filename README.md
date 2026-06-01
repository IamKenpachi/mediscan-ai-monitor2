# 🏥 MediScan AI Monitor

A real-time medical action recognition dashboard powered by **Google Gemini 2.5 Flash**. The system uses a webcam feed to classify patient actions and detect signs of distress through multi-frame video analysis.

---

## ✨ Features

- **Stream Mode** — Real-time continuous classification from a live webcam feed
- **Record Mode** — Record a video clip, then classify the captured action
- **13 Action Classes** — Detects medical-relevant actions including distress signals
- **Session Reporting** — Tracks all classifications with timestamps and export to CSV
- **Distress Alerts** — Visual alerts for critical actions (chest pain, falling down, staggering, etc.)
- **Live Analytics** — Action frequency charts and classification timeline

### Supported Action Classes

| Distress (🔴) | Neutral (🔵) | Normal (🟢) |
|---|---|---|
| Back Pain | Blow Nose | Okay |
| Chest Pain | Fan Self | |
| Falling Down | Sneeze/Cough | |
| Headache | Stretch Oneself | |
| Nausea/Vomiting | Yawn | |
| Neck Pain | | |
| Staggering | | |

---

## 🏗️ Architecture

```
┌──────────────────┐         ┌──────────────────┐         ┌──────────────┐
│   React Frontend │  HTTP   │   Flask Backend   │  API    │  Gemini 2.5  │
│   (Vite :5173)   │────────▶│   (Flask :5000)   │────────▶│    Flash     │
│                  │◀────────│                   │◀────────│              │
│  • Webcam capture│  JSON   │  • Frame resize   │  Text   │  • Multi-img │
│  • Charts/UI     │         │  • Rate limiting  │         │    classify  │
│  • Session log   │         │  • Session store  │         │              │
└──────────────────┘         └──────────────────┘         └──────────────┘
```

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | React 18, TypeScript, Vite, TailwindCSS, Chart.js | UI, webcam capture, analytics |
| Backend | Python, Flask, Flask-CORS | API server, Gemini integration, video processing |
| AI Model | Google Gemini 2.5 Flash | Multi-frame image classification |

---

## 📐 Inference Pipeline

### Frame Sampling (Stream Mode)

| Parameter | Value | Description |
|-----------|-------|-------------|
| `FRAME_SPACING` | 15 | Sample 1 frame every 15 video frames |
| `VIDEO_FPS` | 30 | Assumed camera frame rate |
| Sampling Interval | 500ms | One frame captured every 0.5 seconds (2 Hz) |
| `NUM_FRAMES_PER_INFERENCE` | 3 | Rolling buffer size (deque) |
| Temporal Window | 1.0s | 3 frames × 0.5s spacing |
| `API_COOLDOWN_SECONDS` | 2.0 | Minimum wait between API calls |
| Effective Frequency | ~0.25–0.4 Hz | One classification every ~2.5–4.0 seconds |

### Classification Flow

1. Frames are sampled from the webcam at **2 Hz** and pushed into a rolling buffer
2. Once the buffer holds **3 frames** and the **2.0s cooldown** has passed, a classification request is fired
3. Frames are resized to **512×512** with center padding and sent as JPEG to Gemini
4. Gemini analyzes motion across frames and returns a single action class

---

## 🚀 Getting Started

### Prerequisites

- **Python 3.9+**
- **Node.js 18+** and **npm**
- A **webcam** (for stream/record modes)
- A **Google API Key** with [Gemini API](https://ai.google.dev/) access

### 1. Clone the Repository

```bash
git clone https://github.com/<your-username>/mediscan-ai-monitor2.git
cd mediscan-ai-monitor2
```

### 2. Set Up Environment Variables

Create a `.env` file in the project root:

```env
GOOGLE_API_KEY="your-google-api-key-here"
```

> ⚠️ **Never commit your API key.** The `.env` file is already in `.gitignore`.

### 3. Install & Start the Backend

```bash
# Create virtual environment
python3 -m venv venv
source venv/bin/activate        # Linux/macOS
# venv\Scripts\activate          # Windows

# Install dependencies
pip install --upgrade pip
pip install -r requirements.txt

# Start the Flask server
python app.py
```

The backend starts at **http://localhost:5000**.

### 4. Install & Start the Frontend

Open a **second terminal**:

```bash
# Install Node dependencies
npm install

# Start the Vite dev server
npm run dev
```

The frontend starts at **http://localhost:5173**.

### 5. Use the App

1. Open **http://localhost:5173** in your browser (Chrome recommended)
2. Check the **API status indicator** (top-right) shows **Connected** (green dot)
3. Click **STREAM** for real-time classification or **RECORD** to capture and classify a clip
4. View the **Session Report** and **Export CSV** from the report modal

> **Note:** Both servers must be running simultaneously.

---

## ⚙️ Configuration

### Backend (`app.py`)

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_MODEL_NAME` | `gemini-2.5-flash` | Gemini model to use |
| `NUM_FRAMES_PER_INFERENCE` | `3` | Frames sent per API call |
| `FRAME_SPACING` | `15` | Sample every N-th video frame |
| `API_IMAGE_SIZE` | `(512, 512)` | Frame resize target |
| `JPEG_QUALITY` | `80` | JPEG compression quality |
| `API_COOLDOWN_SECONDS` | `2.0` | Minimum seconds between API calls |

### Frontend (`src/App.tsx`)

| Variable | Default | Description |
|----------|---------|-------------|
| `API_BASE_URL` | `http://localhost:5000` | Backend server URL |
| `SAMPLING_INTERVAL_MS` | `500` | Frame sampling interval (ms) |

---

## 📡 API Endpoints

### `GET /health`
Health check endpoint.

**Response:**
```json
{ "status": "healthy", "api_configured": true }
```

### `POST /api/classify-frames`
Classify action from a sequence of base64-encoded frames (Stream Mode).

**Request:**
```json
{ "frames": ["base64_jpeg_1", "base64_jpeg_2", "base64_jpeg_3"] }
```

**Response:**
```json
{ "classification": "okay", "timestamp": "2026-06-01T12:00:00" }
```

### `POST /api/classify-video`
Classify action from a recorded video (Record Mode).

**Request:**
```json
{ "video": "data:video/webm;base64,..." }
```

**Response:**
```json
{ "classification": "headache", "timestamp": "2026-06-01T12:00:00" }
```

### `GET /api/session-report`
Returns the full session log of all classifications.

### `POST /api/clear-session`
Clears the session log.

---

## 📁 Project Structure

```
mediscan-ai-monitor2/
├── app.py                  # Flask backend (API + Gemini integration)
├── requirements.txt        # Python dependencies
├── .env                    # API key (not committed)
├── index.html              # HTML entry point
├── package.json            # Node.js dependencies
├── vite.config.ts          # Vite configuration
├── tailwind.config.js      # TailwindCSS configuration
├── tsconfig.json           # TypeScript configuration
└── src/
    ├── main.tsx            # React entry point
    ├── App.tsx             # Main application component
    ├── index.css           # Global styles
    └── vite-env.d.ts       # Vite type declarations
```

---

## 🛠️ Troubleshooting

| Problem | Solution |
|---------|----------|
| API shows "Disconnected" | Ensure Flask is running on port 5000 |
| Webcam not working | Allow camera permissions in your browser |
| `GOOGLE_API_KEY not found` | Check `.env` file exists with a valid key |
| `opencv-python` install fails | Use `pip install opencv-python-headless` |
| `npm install` fails | Delete `node_modules/` and `package-lock.json`, retry |
| Node.js version too old | Vite requires Node 18+; use [nvm](https://github.com/nvm-sh/nvm) to upgrade |
| Record mode fails | Ensure sufficient recording time (2+ seconds) |

---

## 📄 License

This project is for educational and research purposes.
