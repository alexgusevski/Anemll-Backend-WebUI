import os
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import StreamingResponse, HTMLResponse
import asyncio
import queue
import threading
import sys
from typing import Generator
import time
import torch
from threading import Event
from fastapi.middleware.cors import CORSMiddleware

# --- Configuration ---
# IMPORTANT: Adjust these paths to your actual setup
CHAT_PY_PATH = "/full-path-to-your-anemll-repo/tests/chat.py" 
MODEL_DIR = "/full-path-to-your-converted-model-directory"
META_YAML = "/full-path-to-your-converted-model-directory/meta.yaml"
# --- End Configuration ---

# Add the directory containing chat.py to the Python path
sys.path.insert(0, os.path.dirname(CHAT_PY_PATH))

# Import necessary functions from chat.py
try:
    from chat import (
        load_models,
        initialize_tokenizer,
        create_unified_state,
        generate_next_token,
        run_prefill,
        TokenPrinter
    )
except ImportError as e:
    print(f"Error: Failed to import required functions from chat.py")
    print(f"Import error details: {str(e)}")
    print(f"Attempted to import from: {CHAT_PY_PATH}")
    print(f"Current Python path: {sys.path}")
    sys.exit(1)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Global Variables (with Thread Safety) ---
model_lock = threading.Lock()
embed_model = None
ffn_models = None
lmhead_model = None
tokenizer = None
state = None
metadata = None
shutdown_event = Event()  # Create as Event instance, not a function

# --- Model Initialization (Startup Event) ---
@app.on_event("startup")
async def startup_event():
    global embed_model, ffn_models, lmhead_model, tokenizer, state, metadata

    class Args:
        def __init__(self, **kwargs):
            for key, value in kwargs.items():
                setattr(self, key, value)

    args = Args(
        meta=META_YAML, # This does not seem to be read correctly hence the params beneath
        d=MODEL_DIR,
        embed=os.path.join(MODEL_DIR, 'llama_embeddings'),
        ffn=os.path.join(MODEL_DIR, 'llama_FFN_PF_lut4_chunk_01of02'),
        lmhead=os.path.join(MODEL_DIR, 'llama_lm_head_lut6'),
        tokenizer=MODEL_DIR,
        prompt=None,
        nw=False,
        context_length=512, # Set this to what your model is
        #batch_size=64 # Whatever you do do not set this to None cus that will break stuff (default is 64)
    )

    with model_lock:
        embed_model, ffn_models, lmhead_model, metadata = load_models(args, {})
        tokenizer = initialize_tokenizer(args.tokenizer)
        state = create_unified_state(ffn_models, metadata['context_length'])

    print("Models and tokenizer initialized.")

@app.on_event("shutdown")
async def shutdown_handler(): 
    """Handles shutdown gracefully."""
    shutdown_event.set()
    print("Shutting down server...")

# --- SSE Streaming Logic ---
def chat_stream(prompt: str, request: Request) -> Generator[str, None, None]:
    global embed_model, ffn_models, lmhead_model, tokenizer, state, metadata

    if not all([embed_model, ffn_models, lmhead_model, tokenizer, state]):
        raise HTTPException(status_code=503, detail="Model not ready")

    try:
        print(f"\nReceived prompt: {prompt}")
        print("Generating response: ", end='', flush=True)  # Start response line
        
        with model_lock:
            context_length = metadata.get('context_length')
            batch_size = metadata.get('batch_size', 64)
            
            # Format prompt
            has_chat_template = False
            try:
                test_messages = [{"role": "user", "content": "test"}]
                tokenizer.apply_chat_template(test_messages, return_tensors="pt")
                has_chat_template = True
            except:
                pass

            if has_chat_template:
                messages = [{"role": "user", "content": prompt}]
                input_ids = tokenizer.apply_chat_template(
                    messages, return_tensors="pt", add_generation_prompt=True
                ).to(torch.int32)
            else:
                formatted_prompt = f"[INST] {prompt} [/INST]"
                input_ids = tokenizer(
                    formatted_prompt, return_tensors="pt", add_special_tokens=True
                ).input_ids.to(torch.int32)

            context_pos = input_ids.size(1)
            current_pos = run_prefill(
                embed_model, ffn_models, input_ids, context_pos, context_length, batch_size, state
            )

            pos = context_pos
            while pos < context_length - 1:
                if shutdown_event.is_set():
                    break

                next_token = generate_next_token(
                    embed_model, ffn_models, lmhead_model, input_ids, pos, context_length, state
                )

                if pos < input_ids.size(1):
                    input_ids[0, pos] = next_token
                else:
                    input_ids = torch.cat([
                        input_ids, torch.tensor([[next_token]], dtype=torch.int32)
                    ], dim=1)

                # Decode and print token
                decoded_token = tokenizer.decode([next_token])
                print(decoded_token, end='', flush=True)  # Print token to server console
                yield f"data: {decoded_token}\n\n"

                pos += 1
                if next_token == tokenizer.eos_token_id:
                    break
            
            print("\nGeneration complete")  # New line after generation is done
                    
    except Exception as e:
        print(f"\nError in chat_stream: {str(e)}")
        raise

@app.post("/chat")
async def chat_endpoint(request: Request):
    try:
        data = await request.json()
        prompt = data.get('prompt')
    except Exception as e:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")

    return StreamingResponse(chat_stream(prompt, request), media_type="text/event-stream")


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Returns a simple hello world message with instructions."""
    return """
    <h1>Hello World!</h1>
    <p>Server is running. Start your frontend and make a POST request to /chat with a "prompt" parameter.</p>
    <p>Example curl request:</p>
    <pre>
    curl -X POST http://localhost:8000/chat \
         -H "Content-Type: application/json" \
         -d '{"prompt": "Tell me a joke"}'
    </pre>
    """