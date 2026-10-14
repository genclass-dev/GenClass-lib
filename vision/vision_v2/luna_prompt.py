# The OpenAI Decisions request of vision/openai_decisions/eval.py (branch wave2/openai-decisions, 517c531) for the
# variant it chose on dev, `luna-img-p3`: image + measured facts + the "judge by the screenshot" caution, two choice
# questions (verdict, 8 options; family, 11 options). The state text is the Clef evaluation's `clef-img-p3` state
# (clef_prompt.py, verbatim), so OpenAI is asked exactly what Clef was asked. Its score is notFine = 1 - P(verdict =
# fine); the family probabilities are kept as well.
#
# build_request() runs on the data node: it reads the crop and returns the JSON body (no key). The Mac adds only the
# Authorization header (openai_label.py).

import base64

import clef_prompt as cp

MODEL = "gpt-6-luna"
API_URL = "https://api.openai.com/v1/decisions"
PRICE_PER_M = {"standard": 0.10}  # USD per million input tokens, no output charge (2026-10-14)
VARIANT = "luna-img-p3"

VERDICT_Q = cp.VERDICT_Q
CRITERIA_P2 = cp.CRITERIA["p2"]
FAMILY_Q = cp.FAMILY_Q
FAMILY_CRITERIA = cp.FAMILY_CRITERIA
GUIDE = cp.GUIDE

# eval.py's text, checked here so a drift in either copy fails loudly
assert VERDICT_Q == "Can a visitor see and use this element as intended?"
assert list(CRITERIA_P2) == ["fine", "unreadable_text", "hidden_control", "broken_image", "cut_off", "overlap", "leak", "blank"]
assert list(FAMILY_CRITERIA) == ["none", "text", "dark", "overflow", "responsive", "occlusion", "media", "leaks", "blank",
                                 "controls", "other"]


def build_state(it):
    """eval.py build_state for luna-img-p3: guide, image words, page words, element words."""
    return "\n".join([GUIDE, cp.image_words(it), cp.page_words(it), cp.element_words(it)])


def questions():
    return [
        {"type": "choice", "name": "verdict", "instructions": VERDICT_Q,
         "choices": [{"value": k, "description": d} for k, d in CRITERIA_P2.items()]},
        {"type": "choice", "name": "family", "instructions": FAMILY_Q,
         "choices": [{"value": k, "description": d} for k, d in FAMILY_CRITERIA.items()]},
    ]


def build_request(it):
    content = [{"type": "input_text", "text": build_state(it)}]
    b64 = base64.b64encode(open(it["img"], "rb").read()).decode()
    content.append({"type": "input_image", "image_url": "data:image/jpeg;base64," + b64})
    return {"model": MODEL, "input": [{"role": "user", "content": content}], "questions": questions()}


def parity_with_clef(it):
    """The state text is clef-img-p3's state, character for character."""
    body = cp.build_request(it, cp.VARIANTS["clef-img-p3"])
    return body["state"] == build_state(it)
