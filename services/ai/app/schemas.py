"""Pydantic models mirroring packages/shared/src/schemas.ts (the Zod contract)."""
from typing import List, Optional, Literal, Dict, Any
from pydantic import BaseModel, Field

Point = Dict[str, float]


class Room(BaseModel):
    label: str
    rawLabel: Optional[str] = None
    type: str
    polygon: List[List[float]]
    centroid: List[float]
    area: float
    confidence: float = Field(ge=0, le=1)
    source: Literal["cv", "manual"] = "cv"
    reviewed: bool = False


class ZoneGeometry(BaseModel):
    kind: Literal["point", "line", "polygon"]
    coords: List[List[float]]


class Zone(BaseModel):
    type: str
    geometry: ZoneGeometry
    confidence: float = Field(ge=0, le=1)
    source: Literal["cv", "manual"] = "cv"


class Detection(BaseModel):
    cls: str = Field(alias="class")
    bbox: List[float]
    confidence: float

    class Config:
        populate_by_name = True


class Placement(BaseModel):
    deviceCode: str
    label: Optional[str] = None
    position: Point
    rotation: float = 0
    scale: float = 1
    locked: bool = False
    hidden: bool = False
    source: Literal["ai", "manual"] = "ai"
    reviewed: bool = False
    rationale: Optional[str] = None
    confidence: Optional[float] = None
    props: Dict[str, Any] = {}
    meta: Dict[str, Any] = {}
    zIndex: int = 0


class QcRejection(BaseModel):
    deviceCode: str = "-"
    reason: str
    confidence: Optional[float] = None
    nearSpace: Optional[str] = None


class AnalysisQcSummary(BaseModel):
    detectedSpaces: int = 0
    acceptedSpaces: int = 0
    rejectedSpaces: int = 0
    rawPlacements: int = 0
    acceptedPlacements: int = 0
    rejectedPlacements: int = 0
    rejections: List[QcRejection] = []


class AnalysisResult(BaseModel):
    floorId: Optional[str] = None
    image: Dict[str, int]
    rooms: List[Room] = []
    zones: List[Zone] = []
    detections: List[Detection] = []
    placements: List[Placement] = []
    confidence: float = 0
    provider: Literal["cv", "llm_fallback"] = "cv"
    warnings: List[str] = []
    qcSummary: Optional[AnalysisQcSummary] = None
    rawRoomCount: Optional[int] = None


class QcOverrides(BaseModel):
    """Admin-tunable quality-control limits forwarded by the worker. All optional;
    unset fields fall back to the defaults in rules/quality.py."""
    maxRoomsPerFloor: Optional[int] = None
    maxDevicesPerFloor: Optional[int] = None
    maxDevicesPerRoom: Optional[int] = None
    minRoomConfidence: Optional[float] = None
    minDeviceConfidence: Optional[float] = None


class AnalyzeRequest(BaseModel):
    imageUrl: Optional[str] = None
    imageB64: Optional[str] = None
    floorId: Optional[str] = None
    units: str = "m"
    provider: Literal["cv", "llm_fallback"] = "cv"
    fallbackProvider: str = "disabled"
    qc: Optional[QcOverrides] = None


class SuggestRequest(BaseModel):
    rooms: List[Room]
    zones: List[Zone] = []


class IngestPage(BaseModel):
    name: str
    width: int
    height: int
    b64: str


class IngestResponse(BaseModel):
    pages: List[IngestPage]
    warnings: List[str] = []
