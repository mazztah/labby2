"""Gravity Maze – FastAPI backend.

Physics engine mirrors the Kotlin implementation so game logic stays in Python;
the frontend only sends sensor input and renders the result.
"""
from __future__ import annotations

import math
import os
from typing import List, Optional

from fastapi import Body, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="Gravity Maze")

# Allow CORS so you can run the backend separately during local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# Permissions-Policy header: Chrome on Android needs this to allow sensor APIs
# (DeviceOrientationEvent / DeviceMotionEvent) in some security contexts.
@app.middleware("http")
async def add_permissions_headers(request, call_next):
    response = await call_next(request)
    response.headers["Permissions-Policy"] = (
        "accelerometer=*, gyroscope=*, magnetometer=*"
    )
    return response


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

class Vec2(BaseModel):
    x: float
    y: float


class Ball(BaseModel):
    pos: Vec2
    vel: Vec2
    radius: float


class Tile(BaseModel):
    x: int
    y: int
    type: str  # "WALL" | "START" | "GOAL" | "COIN" | "HOLE" | "EMPTY"


class CoinState(BaseModel):
    x: int
    y: int
    collected: bool = False


class StepInput(BaseModel):
    accel: Vec2
    dt_seconds: float
    ball: Ball
    tiles: List[Tile]
    coins: List[CoinState] = []


class StepOutput(BaseModel):
    ball: Ball
    coins: List[CoinState]
    score_delta: int = 0
    game_over: bool = False
    level_completed: bool = False


# ---------------------------------------------------------------------------
# Level definition (mirrors MazeLevel1.kt)
# ---------------------------------------------------------------------------

LEVEL_ROWS = [
    "################",
    "#S           ###",
    "# ####### ##   #",
    "#       #      #",
    "# ##### ###### #",
    "#     #        #",
    "# ### ######## #",
    "#   #       C  #",
    "#      ###   Z #",
    "################",
]

TILE_WALL  = "WALL"
TILE_START = "START"
TILE_GOAL  = "GOAL"
TILE_COIN  = "COIN"
TILE_HOLE  = "HOLE"
TILE_EMPTY = "EMPTY"

_CH_MAP = {"#": TILE_WALL, "S": TILE_START, "Z": TILE_GOAL,
           "C": TILE_COIN, "O": TILE_HOLE}


def _parse_level(rows: List[str]):
    tiles: list[Tile] = []
    coins: list[CoinState] = []
    goal: Optional[Tile] = None
    for y, line in enumerate(rows):
        for x, ch in enumerate(line):
            t = _CH_MAP.get(ch, TILE_EMPTY)
            tiles.append(Tile(x=x, y=y, type=t))
            if t == TILE_COIN:
                coins.append(CoinState(x=x, y=y))
            if t == TILE_GOAL:
                goal = Tile(x=x, y=y, type=t)
    return tiles, coins, goal


def _find_start(tiles: list[Tile]) -> Vec2:
    for t in tiles:
        if t.type == TILE_START:
            return Vec2(x=t.x + 0.5, y=t.y + 0.5)
    return Vec2(x=1.5, y=1.5)


TILES, COINS, GOAL_TILE = _parse_level(LEVEL_ROWS)
WORLD_W = len(LEVEL_ROWS[0])
WORLD_H = len(LEVEL_ROWS)
TILE_SIZE = 1.0


# ---------------------------------------------------------------------------
# Physics engine (mirrors PhysicsEngine.kt)
# ---------------------------------------------------------------------------

class PhysicsEngine:
    GRAVITY_SCALE = 9.0
    DAMPING       = 0.985
    WALL_BOUNCE   = -0.20
    WALL_FRICTION  = 0.85
    MAX_SPEED     = 16.0
    MAX_DT        = 1.0 / 30.0

    def __init__(self, tile_size: float):
        self.ts = tile_size

    def step(self, ball: Ball, accel: Vec2, dt_seconds: float,
             tiles: List[Tile]) -> Ball:
        dt = max(0.0, min(dt_seconds, self.MAX_DT))

        damp = self.DAMPING ** (dt * 60.0)
        vx = ball.vel.x * damp + accel.x * self.GRAVITY_SCALE * dt
        vy = ball.vel.y * damp + accel.y * self.GRAVITY_SCALE * dt

        speed = math.sqrt(vx * vx + vy * vy)
        if speed > self.MAX_SPEED and speed > 0:
            s = self.MAX_SPEED / speed
            vx *= s
            vy *= s

        px = ball.pos.x + vx * dt
        py = ball.pos.y + vy * dt
        r  = ball.radius

        for wall in tiles:
            if wall.type != TILE_WALL:
                continue
            left   = wall.x * self.ts
            right  = left + self.ts
            top    = wall.y * self.ts
            bottom = top  + self.ts

            if (px + r <= left or px - r >= right or
                    py + r <= top  or py - r >= bottom):
                continue

            nx_pt = max(left, min(px, right))
            ny_pt = max(top,  min(py, bottom))
            dx = px - nx_pt
            dy = py - ny_pt
            dist2 = dx * dx + dy * dy
            if dist2 > r * r:
                continue

            dist = math.sqrt(max(dist2, 1e-8))
            nx = dx / dist
            ny = dy / dist
            pen = r - dist
            px += nx * pen
            py += ny * pen

            vn = vx * nx + vy * ny
            if vn < 0:
                vx -= (1.0 + self.WALL_BOUNCE) * vn * nx
                vy -= (1.0 + self.WALL_BOUNCE) * vn * ny

            tx = -ny
            ty =  nx
            vt = vx * tx + vy * ty
            vx -= (1.0 - self.WALL_FRICTION) * vt * tx
            vy -= (1.0 - self.WALL_FRICTION) * vt * ty

        return Ball(
            pos=Vec2(x=px, y=py),
            vel=Vec2(x=vx, y=vy),
            radius=r,
        )


_PHYSICS = PhysicsEngine(tile_size=TILE_SIZE)


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------

@app.get("/healthz")
def health():
    return {"status": "ok"}


@app.get("/api/level")
def api_level():
    """Return static level data – called once on page load."""
    return {
        "tile_size":        TILE_SIZE,
        "world_width_tiles":  WORLD_W,
        "world_height_tiles": WORLD_H,
        "tiles":  [t.model_dump() for t in TILES],
        "start":  _find_start(TILES).model_dump(),
        "goal":   GOAL_TILE.model_dump() if GOAL_TILE else None,
        "coins":  [c.model_dump() for c in COINS],
        "hole_tiles": [t.model_dump() for t in TILES if t.type == TILE_HOLE],
    }


@app.post("/api/step", response_model=StepOutput)
def api_step(inp: StepInput = Body(...)):
    """Advance physics by one timestep and return the new state."""
    new_ball = _PHYSICS.step(
        ball=inp.ball, accel=inp.accel,
        dt_seconds=inp.dt_seconds, tiles=inp.tiles,
    )

    # Clamp ball inside world
    max_x = WORLD_W * TILE_SIZE
    max_y = WORLD_H * TILE_SIZE
    new_ball.pos.x = max(new_ball.radius, min(new_ball.pos.x, max_x - new_ball.radius))
    new_ball.pos.y = max(new_ball.radius, min(new_ball.pos.y, max_y - new_ball.radius))

    coins = list(inp.coins)
    score_delta = 0
    n_collected = 0

    for c in coins:
        if not c.collected:
            dx = new_ball.pos.x - (c.x + 0.5)
            dy = new_ball.pos.y - (c.y + 0.5)
            if math.sqrt(dx * dx + dy * dy) < 0.65:
                c.collected = True
                n_collected += 1

    if n_collected:
        bonus = 500 if all(c.collected for c in coins) else 0
        score_delta += n_collected * 100 + bonus

    # Hole check → game over
    for t in inp.tiles:
        if t.type == TILE_HOLE:
            dx = new_ball.pos.x - (t.x + 0.5)
            dy = new_ball.pos.y - (t.y + 0.5)
            if math.sqrt(dx * dx + dy * dy) < 0.45:
                return StepOutput(ball=new_ball, coins=coins,
                                  score_delta=score_delta, game_over=True)

    # Goal check → level complete
    if GOAL_TILE:
        dx = new_ball.pos.x - (GOAL_TILE.x + 0.5)
        dy = new_ball.pos.y - (GOAL_TILE.y + 0.5)
        if math.sqrt(dx * dx + dy * dy) < 0.55:
            score_delta += 5000
            return StepOutput(ball=new_ball, coins=coins,
                              score_delta=score_delta, level_completed=True)

    return StepOutput(ball=new_ball, coins=coins, score_delta=score_delta)


@app.get("/")
def root():
    return FileResponse("static/index.html")


# Static files must be mounted AFTER explicit routes
app.mount("/static", StaticFiles(directory="static"), name="static")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=False)
