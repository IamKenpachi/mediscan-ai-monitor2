"""
Medical AI Monitoring Dashboard - Flask Backend
Handles real-time frame classification and video classification via Gemini API
"""

import os
import time
import base64
import io
import json
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS
import google.generativeai as genai
from dotenv import load_dotenv
from PIL import Image
import cv2
import numpy as np

# Load environment variables from .env file
load_dotenv()

# Initialize Flask app
app = Flask(__name__)
CORS(app)

# Configuration variables (exactly as specified)
GEMINI_MODEL_NAME = "gemini-2.0-flash"
NUM_FRAMES_PER_INFERENCE = 3
FRAME_SPACING = 15
API_IMAGE_SIZE = (512, 512)
JPEG_QUALITY = 80
API_COOLDOWN_SECONDS = 2.0
ACTION_CLASSES = [
    'back pain', 'blow nose', 'chest pain', 'falling down', 'fan self',
    'headache', 'nausea/vomiting', 'neck pain', 'okay', 'sneeze/cough',
    'staggering', 'stretch oneself', 'yawn'
]
SYSTEM_INSTRUCTION = (
    "You are an expert AI medical monitoring assistant deployed in a healthcare environment.\n"
    "You will receive a short sequence of consecutive video frames showing a patient or person.\n"
    "Your task is to analyze the patient's MOVEMENT and POSTURE across all frames and classify "
    "their current action.\n\n"
    "You MUST choose EXACTLY ONE category from this list:\n"
    "back pain, blow nose, chest pain, falling down, fan self, headache, "
    "nausea/vomiting, neck pain, okay, sneeze/cough, staggering, stretch oneself, yawn\n\n"
    "Strict Rules:\n"
    "1. Study the CHANGE across frames, not just a single frame.\n"
    "2. Look for distress signals: clutching the chest/head/neck, bending over in pain, "
    "loss of balance, covering the face.\n"
    "3. 'okay' means calm, normal activity — walking, sitting, standing with no visible distress.\n"
    "4. Output ONLY the exact category name. No explanation, no punctuation, no extra words.\n"
)

# Initialize Gemini API
api_key = os.getenv('GOOGLE_API_KEY')
if not api_key:
    raise ValueError("GOOGLE_API_KEY not found in environment variables")

genai.configure(api_key=api_key)
model = genai.GenerativeModel(
    model_name=GEMINI_MODEL_NAME,
    system_instruction=SYSTEM_INSTRUCTION
)

# Session storage for classification results
session_log = []

# Cooldown tracking
last_api_call_time = 0


def enforce_cooldown():
    """Enforce API cooldown between calls to prevent rate limiting."""
    global last_api_call_time
    current_time = time.time()
    time_since_last_call = current_time - last_api_call_time

    if time_since_last_call < API_COOLDOWN_SECONDS:
        time.sleep(API_COOLDOWN_SECONDS - time_since_last_call)

    last_api_call_time = time.time()


def resize_and_encode_frame(frame_data, target_size=API_IMAGE_SIZE):
    """
    Resize a frame to target size and encode as base64 JPEG.

    Args:
        frame_data: Either base64 string or numpy array
        target_size: Tuple of (width, height)

    Returns:
        PIL Image object
    """
    if isinstance(frame_data, str):
        # Decode base64 to image
        image_bytes = base64.b64decode(frame_data)
        image = Image.open(io.BytesIO(image_bytes))
    else:
        # Already a numpy array
        image = Image.fromarray(cv2.cvtColor(frame_data, cv2.COLOR_BGR2RGB))

    # Resize maintaining aspect ratio with padding
    image.thumbnail(target_size, Image.Resampling.LANCZOS)

    # Create new image with target size and paste resized image centered
    new_image = Image.new('RGB', target_size, (0, 0, 0))
    paste_x = (target_size[0] - image.width) // 2
    paste_y = (target_size[1] - image.height) // 2
    new_image.paste(image, (paste_x, paste_y))

    return new_image


def classify_frames_with_gemini(frames):
    """
    Send frames to Gemini API for classification.

    Args:
        frames: List of PIL Image objects

    Returns:
        Classification string from Gemini
    """
    enforce_cooldown()

    # Build content with all frames
    content = []

    # Add instruction text
    content.append(f"Analyze these {len(frames)} consecutive frames and classify the action. "
                   f"Choose EXACTLY ONE from: {', '.join(ACTION_CLASSES)}. "
                   f"Output ONLY the category name.")

    # Add each frame
    for i, frame in enumerate(frames):
        # Convert PIL Image to bytes
        buffer = io.BytesIO()
        frame.save(buffer, format='JPEG', quality=JPEG_QUALITY)
        image_bytes = buffer.getvalue()

        # Create image part
        content.append({
            'mime_type': 'image/jpeg',
            'data': base64.b64encode(image_bytes).decode('utf-8')
        })

    try:
        response = model.generate_content(content)
        classification = response.text.strip().lower()

        # Validate classification is in allowed classes
        # Find closest match from action classes
        for action in ACTION_CLASSES:
            if action in classification or classification in action:
                return action

        # Default to first word if no match
        return classification.split()[0] if classification else 'okay'

    except Exception as e:
        print(f"Error calling Gemini API: {str(e)}")
        raise


def extract_frames_from_video(video_bytes):
    """
    Extract evenly spaced frames from video using OpenCV.

    Args:
        video_bytes: Raw video data

    Returns:
        List of PIL Image objects
    """
    # Write video to temporary file for OpenCV
    temp_path = '/tmp/temp_video.mp4'
    with open(temp_path, 'wb') as f:
        f.write(video_bytes)

    # Open video file
    cap = cv2.VideoCapture(temp_path)

    if not cap.isOpened():
        raise ValueError("Could not open video file")

    # Get video properties
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)

    # Calculate frame indices for evenly spaced extraction
    if total_frames <= NUM_FRAMES_PER_INFERENCE:
        frame_indices = list(range(total_frames))
    else:
        frame_indices = [
            int(i * total_frames / NUM_FRAMES_PER_INFERENCE)
            for i in range(NUM_FRAMES_PER_INFERENCE)
        ]

    # Extract frames at calculated indices
    frames = []
    for idx in frame_indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if ret:
            # Convert BGR to RGB and create PIL Image
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            pil_image = Image.fromarray(frame_rgb)

            # Resize to target size
            pil_image.thumbnail(API_IMAGE_SIZE, Image.Resampling.LANCZOS)

            # Pad to exact size
            new_image = Image.new('RGB', API_IMAGE_SIZE, (0, 0, 0))
            paste_x = (API_IMAGE_SIZE[0] - pil_image.width) // 2
            paste_y = (API_IMAGE_SIZE[1] - pil_image.height) // 2
            new_image.paste(pil_image, (paste_x, paste_y))

            frames.append(new_image)

    cap.release()

    # Clean up temp file
    try:
        os.remove(temp_path)
    except:
        pass

    return frames


@app.route('/api/classify-frames', methods=['POST'])
def classify_frames():
    """
    Classify action from a sequence of frames in Stream Mode.

    Request body:
        {
            "frames": ["base64_jpeg_1", "base64_jpeg_2", ...]
        }

    Response:
        {
            "classification": "action_class"
        }
    """
    try:
        data = request.get_json()

        if not data or 'frames' not in data:
            return jsonify({'error': 'No frames provided'}), 400

        raw_frames = data['frames']

        if len(raw_frames) == 0:
            return jsonify({'error': 'Empty frames list'}), 400

        # Process each frame - resize and convert to PIL Image
        frames = []
        for frame_data in raw_frames:
            pil_image = resize_and_encode_frame(frame_data)
            frames.append(pil_image)

        # Call Gemini API
        classification = classify_frames_with_gemini(frames)

        # Log to session
        timestamp = datetime.now().isoformat()
        session_log.append({
            'classification': classification,
            'timestamp': timestamp,
            'mode': 'stream'
        })

        return jsonify({
            'classification': classification,
            'timestamp': timestamp
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/classify-video', methods=['POST'])
def classify_video():
    """
    Classify action from a recorded video in Record Mode.

    Request body:
        {
            "video": "base64_encoded_video"
        }

    Response:
        {
            "classification": "action_class",
            "timestamp": "ISO_timestamp"
        }
    """
    try:
        data = request.get_json()

        if not data or 'video' not in data:
            return jsonify({'error': 'No video provided'}), 400

        # Decode base64 video
        video_data = data['video']

        # Handle data URL prefix if present
        if ',' in video_data:
            video_data = video_data.split(',')[1]

        video_bytes = base64.b64decode(video_data)

        # Extract frames from video
        frames = extract_frames_from_video(video_bytes)

        if len(frames) == 0:
            return jsonify({'error': 'Could not extract frames from video'}), 400

        # Call Gemini API
        classification = classify_frames_with_gemini(frames)

        # Log to session
        timestamp = datetime.now().isoformat()
        session_log.append({
            'classification': classification,
            'timestamp': timestamp,
            'mode': 'record'
        })

        return jsonify({
            'classification': classification,
            'timestamp': timestamp
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/session-report', methods=['GET'])
def get_session_report():
    """
    Get the full session log of all classifications.

    Response:
        [
            {
                "classification": "action_class",
                "timestamp": "ISO_timestamp",
                "mode": "stream|record"
            },
            ...
        ]
    """
    return jsonify(session_log)


@app.route('/api/clear-session', methods=['POST'])
def clear_session():
    """Clear the session log."""
    global session_log
    session_log = []
    return jsonify({'status': 'cleared'})


@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint."""
    return jsonify({
        'status': 'healthy',
        'api_configured': bool(api_key)
    })


if __name__ == '__main__':
    print("=" * 60)
    print("Medical AI Monitoring Dashboard - Backend Server")
    print("=" * 60)
    print(f"Gemini Model: {GEMINI_MODEL_NAME}")
    print(f"Frames per inference: {NUM_FRAMES_PER_INFERENCE}")
    print(f"API Cooldown: {API_COOLDOWN_SECONDS}s")
    print("=" * 60)
    print("Starting Flask server on http://localhost:5000")
    print("=" * 60)

    app.run(host='0.0.0.0', port=5000, debug=True)
