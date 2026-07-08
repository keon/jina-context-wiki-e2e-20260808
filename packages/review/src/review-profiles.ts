export interface ReviewProfile {
  readonly slug: string;
  readonly required: boolean;
}

export function isRequiredProfile(profile: ReviewProfile): boolean {
  return profile.required;
}

