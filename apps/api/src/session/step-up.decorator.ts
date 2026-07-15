import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { STEP_UP_PURPOSE_METADATA } from './step-up.guard';
import { StepUpGuard } from './step-up.guard';
import type { StepUpPurpose } from './session.service';

export const RequireStepUp = (purpose: StepUpPurpose) =>
  applyDecorators(
    SetMetadata(STEP_UP_PURPOSE_METADATA, purpose),
    UseGuards(StepUpGuard),
  );
