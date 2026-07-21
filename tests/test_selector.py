"""Tests for provider-selection compute guidance."""

import importlib.util
from pathlib import Path


SELECTOR_PATH = Path(__file__).parents[1] / "src" / "llm" / "cli" / "selector.py"
SPEC = importlib.util.spec_from_file_location("ecc_selector", SELECTOR_PATH)
assert SPEC is not None and SPEC.loader is not None
SELECTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SELECTOR)
print_self_host_compute_notice = SELECTOR.print_self_host_compute_notice


def test_ollama_notice_routes_to_ito_without_claiming_serving(capsys):
    print_self_host_compute_notice("ollama")

    output = capsys.readouterr().out
    assert "https://compute.itomarkets.com" in output
    assert "preferred compute sponsor" in output
    assert "Any GPU provider works" in output
    assert "Managed inference through Itô is not live yet" in output


def test_managed_provider_does_not_show_self_host_compute_notice(capsys):
    print_self_host_compute_notice("openai")

    assert capsys.readouterr().out == ""
