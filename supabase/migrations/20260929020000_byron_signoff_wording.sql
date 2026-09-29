-- The owner line of the contractor agreement reads "Byron Hawley, Owner." and
-- nothing more. 20260929010000 added a second sentence nobody asked for; this
-- takes it back out. Only a description still reading exactly that way
-- changes, so wording an owner has since edited in the builder stays theirs.
update public.xert_forms form
set questions = (
  select jsonb_agg(
    case
      when item.question ->> 'id' = 'ic-98-owner-signature'
        and item.question ->> 'description' = 'Byron Hawley, Owner. His signature is on every copy of this agreement.' then
        item.question || jsonb_build_object('description', 'Byron Hawley, Owner.')
      else item.question
    end
    order by item.position)
  from jsonb_array_elements(form.questions) with ordinality as item(question, position)
)
where form.questions @> '[{"id": "ic-98-owner-signature", "description": "Byron Hawley, Owner. His signature is on every copy of this agreement."}]'::jsonb;
