import { redirect } from "next/navigation";

/**
 * The till is the app; `/` is only an entry point. Bounced straight to the POS,
 * which handles the "not signed in yet" case itself.
 */
export default function Home() {
  redirect("/pos");
}
