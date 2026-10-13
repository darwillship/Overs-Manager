grant select, insert, update on public.overs_staff, public.overs_locations, public.overs_settings, public.overs_records, public.overs_products, public.overs_containers, public.overs_photos to authenticated;
grant delete on public.overs_photos, public.overs_containers to authenticated;
grant select, insert on public.overs_reviews, public.overs_events to authenticated;
grant select on public.overs_members to authenticated;
grant execute on function public.overs_is_member() to authenticated;
revoke all on public.overs_staff, public.overs_locations, public.overs_settings, public.overs_records, public.overs_products, public.overs_containers, public.overs_photos, public.overs_reviews, public.overs_events, public.overs_members from anon;
revoke execute on function public.overs_is_member() from anon, public;;
