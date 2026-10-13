"""Make ``fabric`` importable when pytest runs from the repository root.

Fabric has no compiled extension and no install step beyond NumPy, so the test
suite runs straight from a checkout.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
