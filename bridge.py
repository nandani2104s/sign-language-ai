import json
import os
import pickle
import time

import cv2
import mediapipe as mp
import numpy as np
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from normalization import normalize_hand_landmarks
from stabilizer import SignStabilizerAndSentenceBuilder
from vocabulary import ALL_CLASSES

app = FastAPI(title="Sign Language AI Real-Time Bridge (Expanded)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MODEL_PATH = 'model.p'
if os.path.exists(MODEL_PATH):
    with open(MODEL_PATH, 'rb') as f:
        bundle = pickle.load(f)
    model = bundle['model']
    classes = bundle['classes']
    print(f"Loaded trained model with {len(classes)} classes successfully.")
else:
    model = None
    classes = ALL_CLASSES
    print("Warning: model.p not found! Run train_model.py first.")

# static_image_mode=False keeps tracking between frames; the frames now come from the browser.
mp_hands = mp.solutions.hands
hands = mp_hands.Hands(
    static_image_mode=False,
    max_num_hands=1,
    min_detection_confidence=0.6,
    min_tracking_confidence=0.5,
)


@app.get("/health")
def health_status():
    return {
        "status": "online",
        "model_loaded": model is not None,
        "total_classes": len(classes),
        "supported_classes": classes,
    }


def make_stabilizer():
    return SignStabilizerAndSentenceBuilder(window_size=10, consensus_threshold=7, pause_flush_sec=1.6)


def reset_stabilizer(s):
    s.window.clear()
    s.current_word.clear()
    s.confirmed_glosses.clear()
    s.last_confirmed_sign = None


@app.websocket("/ws")
async def sign_stream(websocket: WebSocket):
    """
    The browser owns the webcam and sends JPEG frames as binary messages.
    It can also send {"type": "clear"} to reset the word/sentence buffers.
    After every message the server replies with one JSON payload.
    """
    await websocket.accept()
    stabilizer = make_stabilizer()
    print("WebSocket client connected. Waiting for frames from the browser...")

    try:
        while True:
            msg = await websocket.receive()
            if msg["type"] == "websocket.disconnect":
                break

            t0 = time.perf_counter()
            raw_sign = "-"

            if msg.get("text"):
                try:
                    command = json.loads(msg["text"])
                except json.JSONDecodeError:
                    continue
                if command.get("type") == "clear":
                    reset_stabilizer(stabilizer)
                    stable_sign, display_buffer, spoken_sentence = None, "", None
                else:
                    continue

            elif msg.get("bytes"):
                frame = cv2.imdecode(np.frombuffer(msg["bytes"], np.uint8), cv2.IMREAD_COLOR)
                if frame is None:
                    continue

                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                results = hands.process(rgb)

                if results.multi_hand_landmarks and model is not None:
                    hand_lms = results.multi_hand_landmarks[0]
                    coords = [[lm.x, lm.y, lm.z] for lm in hand_lms.landmark]
                    norm_vec = normalize_hand_landmarks(coords)
                    pred_id = model.predict([norm_vec])[0]
                    raw_sign = classes[pred_id]

                stable_sign, display_buffer, spoken_sentence = stabilizer.update(raw_sign)
            else:
                continue

            latency_ms = (time.perf_counter() - t0) * 1000
            fps = int(1000.0 / latency_ms) if latency_ms > 0 else 30

            await websocket.send_text(json.dumps({
                "raw_sign": raw_sign,
                "confirmed_sign": stable_sign if stable_sign else "-",
                "display_buffer": display_buffer,
                "spoken_sentence": spoken_sentence if spoken_sentence else "",
                "fps": fps,
                "latency_ms": round(latency_ms, 1),
            }))

    except Exception as e:
        print(f"Stream error: {e}")
    finally:
        print("WebSocket client disconnected.")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("bridge:app", host="0.0.0.0", port=8000, reload=True)
