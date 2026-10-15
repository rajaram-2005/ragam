"""The Colab notebook and its job template: generated, parseable, and honest about its state.

The notebook cannot be executed in CI, which has no GPU and installs no torch. What CAN
be checked is that it is exactly what its builder produces, that its Python parses,
and that it refuses to run on Kaggle and while placeholders remain.
"""

from __future__ import annotations

import ast
import importlib.util
import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NOTEBOOK = REPO / "remote" / "notebooks" / "klyvaron-chat-lora-colab.ipynb"
BUILDER = REPO / "remote" / "build_notebook.py"


def _builder():
    spec = importlib.util.spec_from_file_location("build_notebook", BUILDER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _code_cells(notebook: dict) -> list:
    return [''.join(cell["source"]) for cell in notebook["cells"] if cell["cell_type"] == "code"]


def test_the_committed_notebook_is_exactly_what_the_builder_produces():
    """Drift guard: edit the builder, rerun it, commit both. Never hand-edit the notebook."""
    assert NOTEBOOK.read_text(encoding="utf-8") == _builder().build()


def test_every_code_cell_parses_once_ipython_magics_are_removed():
    notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    for index, source in enumerate(_code_cells(notebook)):
        python = "\n".join(line for line in source.split("\n") if not line.lstrip().startswith(("%", "!")))
        ast.parse(python, filename=f"cell {index}")


def test_the_notebook_refuses_to_run_on_kaggle_and_while_placeholders_remain():
    text = "\n".join(_code_cells(json.loads(NOTEBOOK.read_text(encoding="utf-8"))))
    assert 'os.path.exists("/kaggle")' in text
    assert "refuses to run on Kaggle" in text
    assert 'if "REPLACE_" in REPO_COMMIT' in text
    assert "load_job(JOB_FILE)" in text   # the job contract, including placeholders, is enforced


def test_the_notebook_states_that_it_has_not_been_executed():
    first = ''.join(json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"][0]["source"])
    assert "not executed" in first.lower()
    assert "Klyvaron model in the family sense" in first


def test_the_notebook_is_not_wired_into_any_ci_job():
    workflows = REPO.parent.parent / ".github" / "workflows"
    if not workflows.exists():
        return
    for path in workflows.glob("*.yml"):
        assert "build_notebook" not in path.read_text(encoding="utf-8")
        assert "klyvaron-chat-lora-colab" not in path.read_text(encoding="utf-8")


def test_the_template_job_lives_in_the_repo_and_validates_as_a_refusal():
    from fabric.training.jobspec import validate_job

    template = json.loads((REPO / "remote" / "jobs" / "klyvaron-chat-lora-experiment.json").read_text())
    problems = validate_job(template)
    assert problems and all("REPLACE" in p or "placeholder" in p or "must be" in p or "below" in p
                            or "allowlist" in p or "SHA-256" in p for p in problems)
