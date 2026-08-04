export function clerkAuthRedirect({
  isLoaded,
  isSignedIn,
  isSigninPage,
}: {
  isLoaded: boolean;
  isSignedIn: boolean;
  isSigninPage: boolean;
}): "/signin" | "/reviews" | null {
  if (!isLoaded) return null;
  if (!isSignedIn && !isSigninPage) return "/signin";
  if (isSignedIn && isSigninPage) return "/reviews";
  return null;
}
