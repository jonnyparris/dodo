type OnboardingStep = "welcome" | "gateway" | "passkey" | "secrets" | "memory" | "integrations" | "complete";

export interface OnboardingState {
  currentStep: OnboardingStep;
  completedSteps: OnboardingStep[];
  startedAt: string | null;
  completedAt: string | null;
}

const STEP_ORDER: OnboardingStep[] = ["welcome", "gateway", "passkey", "secrets", "memory", "integrations", "complete"];

export function getNextStep(current: OnboardingStep): OnboardingStep {
  // Skipping a step doesn't change *which* step comes next — it just
  // marks the current one done without requiring data. The pass-through
  // `skip` parameter was vestigial. (audit follow-up F8)
  const idx = STEP_ORDER.indexOf(current);
  if (idx === -1 || idx >= STEP_ORDER.length - 1) return "complete";
  return STEP_ORDER[idx + 1];
}

export function canSkipStep(step: OnboardingStep, hasKeyEnvelope: boolean): boolean {
  switch (step) {
    case "welcome":
      return true;
    case "gateway":
      return false; // Must configure own AI provider
    case "passkey":
      return hasKeyEnvelope;
    case "secrets":
      return true;
    case "memory":
      return true;
    case "integrations":
      return true;
    case "complete":
      return false;
    default:
      return false;
  }
}

export function getInitialState(): OnboardingState {
  return {
    currentStep: "welcome",
    completedSteps: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
}

export function advanceStep(
  state: OnboardingState,
  step: OnboardingStep,
  skip: boolean,
  hasKeyEnvelope: boolean,
): OnboardingState {
  // Must advance from the current step
  if (step !== state.currentStep) {
    throw new Error(`Cannot advance step '${step}' — current step is '${state.currentStep}'`);
  }

  // Already complete — no further advancement
  if (state.currentStep === "complete") {
    return state;
  }

  // If skipping, verify the step is skippable
  if (skip && !canSkipStep(step, hasKeyEnvelope)) {
    throw new Error(`Step '${step}' cannot be skipped`);
  }

  const completedSteps = state.completedSteps.includes(step)
    ? state.completedSteps
    : [...state.completedSteps, step];

  const nextStep = getNextStep(step);
  const isComplete = nextStep === "complete";

  return {
    currentStep: nextStep,
    completedSteps: isComplete ? [...completedSteps, "complete"] : completedSteps,
    startedAt: state.startedAt,
    completedAt: isComplete ? new Date().toISOString() : null,
  };
}
