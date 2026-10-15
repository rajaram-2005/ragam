"""The smoke notebook: generated, parseable, thin, and honest about not having been run.

CI has no GPU and no torch, so the notebook itself cannot run here. What can be checked:
it is exactly what its builder produces, its code parses, it calls the tested orchestration
instead of duplicating it, it needs no Google Drive mount, and it says it has not been executed.
"""

from __future__ import annotations

import ast
import importlib.util
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NOTEBOOK = REPO / "remote" / "notebooks" / "klyvaron-chat-lora-smoke.ipynb"
BUILDER = REPO / "remote" / "build_notebook.py"


def _builder():
    spec = importlib.util.spec_from_file_location("build_notebook", BUILDER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _notebook() -> dict:
    return json.loads(NOTEBOOK.read_text(encoding="utf-8"))


def _code(notebook: dict) -> str:
    return "\n".join("".join(cell["source"]) for cell in notebook["cells"] if cell["cell_type"] == "code")


def _markdown(notebook: dict) -> str:
    return "\n".join("".join(cell["source"]) for cell in notebook["cells"] if cell["cell_type"] == "markdown")


def test_the_committed_notebook_is_exactly_what_the_builder_produces():
    """Drift guard: edit the builder, rerun it, commit both. Never hand-edit the notebook."""
    assert NOTEBOOK.read_text(encoding="utf-8") == _builder().build()


def test_every_code_cell_parses_once_ipython_magics_are_removed():
    for index, cell in enumerate(_notebook()["cells"]):
        if cell["cell_type"] != "code":
            continue
        source = "".join(cell["source"])
        python = "\n".join(line for line in source.split("\n") if not line.lstrip().startswith(("%", "!")))
        ast.parse(python, filename=f"cell {index}")


def test_the_notebook_calls_the_tested_orchestration_and_does_not_reimplement_it():
    code = _code(_notebook())
    assert "from fabric.training.smoke import" in code
    assert "run_smoke(" in code
    assert "from fabric.training.hf_peft import HFPeftBackend" in code
    assert "load_job(" in code          # the job contract, including placeholder refusal, is enforced
    assert "klyvaron-chat-lora-smoke.ipynb" not in code


def test_the_notebook_needs_no_google_drive_and_names_the_kaggle_path():
    text = json.dumps(_notebook())
    assert "drive.mount" not in text
    assert "/kaggle/working" in text
    assert "Save & Run All" in _markdown(_notebook())


def test_the_notebook_states_that_it_has_not_been_executed_and_what_is_synthetic():
    markdown = _markdown(_notebook())
    assert "NOT EXECUTED" in markdown
    assert "synthetic" in markdown.lower()
    assert "not a quality claim" in markdown.lower() or "not a klyvaron model" in markdown.lower()


def test_the_notebook_reports_each_stage_as_passed_failed_or_not_run():
    markdown = _markdown(_notebook())
    for word in ("PASSED", "FAILED", "NOT RUN"):
        assert word in markdown


def test_the_notebook_pins_the_base_and_package_versions():
    code = _code(_notebook())
    assert "transformers==5.19.0" in code
    assert "peft==0.21.2" in code


def test_the_clone_cell_says_why_it_failed_instead_of_raising_an_exit_code():
    """A run that dies in this cell used to raise CalledProcessError with the reason only in
    git's output, which is easy to lose. The three failures that actually happen -- no route to
    github.com (Kaggle's Internet switch is off by default), a branch that no longer resolves
    (a saved copy of this notebook), and a connection that is reached but never finishes
    (transient, so retry first) -- must each name themselves and the remedy."""
    code = _code(_notebook())
    assert "Could not resolve host" in code, "the internet-off diagnosis is missing"
    assert "Internet" in code and "On" in code, "the remedy must name the switch to turn on"
    assert "Remote branch" in code, "the deleted-branch diagnosis is missing"
    assert "re-import" in code.lower(), "the deleted-branch remedy must say what to do"
    assert "reached github.com" in code, "the reached-but-incomplete diagnosis is missing"
    assert "Retry first" in code, "the transient failure must say to retry before blaming settings"
    assert "RuntimeError" in code, "the cell must stop with a readable message"
    assert "SystemExit" not in code, "an interpreter exit shows on Kaggle as a bare warning"
    assert "check=True" not in code, "the raw exit code is what made this unreadable"


def test_the_clone_cell_installs_the_pinned_packages_through_the_same_helper():
    code = _code(_notebook())
    assert "pip" in code and "install" in code
    assert 'run([sys.executable, "-m", "pip", "install"' in code


def test_the_notebook_clones_a_published_branch_not_a_session_branch():
    """A session branch (arena/...) is deleted when that session ends, and this notebook is
    meant to be run months later by someone else. It must clone a branch that outlives a
    session; the exact commit it got is recorded in status.json either way."""
    code = _code(_notebook())
    assert 'REPO_REF = "main"' in code
    assert not re.search(r'REPO_REF\s*=\s*"arena/', code)


def test_the_superseded_colab_only_notebook_is_gone():
    assert not (REPO / "remote" / "notebooks" / "klyvaron-chat-lora-colab.ipynb").exists()


def test_the_notebook_is_not_wired_into_any_ci_job():
    workflows = REPO.parent.parent / ".github" / "workflows"
    if not workflows.exists():
        return
    for path in workflows.glob("*.yml"):
        text = path.read_text(encoding="utf-8")
        assert "build_notebook" not in text
        assert "klyvaron-chat-lora-smoke" not in text
