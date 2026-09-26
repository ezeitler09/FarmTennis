-- Identity helpers only mean something for signed-in users.
-- roster_email_ok stays callable by anon on purpose: the sign-in form uses it.
-- report_result / clear_result are callable by signed-in users on purpose:
-- they check inside that the caller is one of the two players or an admin.
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.my_player_id() from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.my_player_id() to authenticated;
