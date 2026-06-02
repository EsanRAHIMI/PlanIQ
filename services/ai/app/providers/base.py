"""VisionProvider interface. CvProvider is the default, self-hosted engine.
LLM providers are optional fallbacks, disabled in the normal production flow."""
from abc import ABC, abstractmethod
import numpy as np

from ..schemas import AnalysisResult


class VisionProvider(ABC):
    @abstractmethod
    def analyze(self, bgr: np.ndarray, floor_id: str | None) -> AnalysisResult:
        ...
