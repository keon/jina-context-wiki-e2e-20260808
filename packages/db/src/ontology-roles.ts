export const ONTOLOGY_ROLES_SQL = `
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname='jina_ontology_reader') then
    create role jina_ontology_reader nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname='jina_ontology_writer') then
    create role jina_ontology_writer nologin;
  end if;
end
$roles$;

revoke all on schema jina_ontology from public;
revoke all on all tables in schema jina_ontology from public;
revoke all on all sequences in schema jina_ontology from public;
revoke execute on all functions in schema jina_ontology from public;

grant usage on schema jina_ontology to jina_ontology_reader,jina_ontology_writer;
grant select on all tables in schema jina_ontology to jina_ontology_reader;
grant select,insert,update,delete on all tables in schema jina_ontology to jina_ontology_writer;
grant usage,select on all sequences in schema jina_ontology to jina_ontology_writer;
grant execute on all functions in schema jina_ontology to jina_ontology_reader,jina_ontology_writer;

alter default privileges in schema jina_ontology revoke all on tables from public;
alter default privileges in schema jina_ontology revoke all on sequences from public;
alter default privileges in schema jina_ontology revoke execute on functions from public;
alter default privileges in schema jina_ontology grant select on tables to jina_ontology_reader;
alter default privileges in schema jina_ontology grant select,insert,update,delete on tables to jina_ontology_writer;
alter default privileges in schema jina_ontology grant usage,select on sequences to jina_ontology_writer;
alter default privileges in schema jina_ontology grant execute on functions to jina_ontology_reader,jina_ontology_writer;
`;
