from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from mst import compute_mst, OptimizationRequest

app = FastAPI(title="Renewvia MST Optimizer")

# Allow frontend to call this (update for production domain)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:8000",
        "https://c4g-renewvia.vercel.app",  # ← replace with your real domain
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/optimize")
async def optimize(request: OptimizationRequest):
    if len(request.points) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 points")

    try:
        result = compute_mst(request)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))