#include "prolog_core.h"
#include <stdio.h>
#include <string.h>
#include <assert.h>

static int tests_run = 0, tests_passed = 0;
static void pass(const char *name) { tests_run++; tests_passed++; printf("  ok  %s\n", name); }

int main(void) {
    PrologCore pc;
    pc_init(&pc);

    printf("=== Atom interning ===\n");
    { uint32_t id = pc_intern_atom(&pc, "hello"); assert(strcmp(pc_atom_name(&pc, id), "hello") == 0); pass("intern and retrieve"); }
    { uint32_t a = pc_intern_atom(&pc, "world"), b = pc_intern_atom(&pc, "world"); assert(a == b); pass("same string same id"); }
    { assert(strcmp(pc_atom_name(&pc, 0), "[]") == 0); pass("[] is atom 0"); }

    printf("\n=== Term construction ===\n");
    { Term t = pc_make_atom(&pc, "x"); assert(TERM_TAG(t)==TAG_ATOM); assert(strcmp(pc_atom_name(&pc,ATOM_ID(t)),"x")==0); pass("atom term"); }
    { Term t = pc_make_num(42); assert(TERM_TAG(t)==TAG_NUM && NUM_VALUE(t)==42); pass("num term"); }
    { Term t = TERM_VAR(7); assert(TERM_TAG(t)==TAG_VAR && VAR_ID(t)==7); pass("var term"); }
    {
        Term args[2] = { pc_make_atom(&pc,"a"), pc_make_num(1) };
        uint32_t fid = pc_intern_atom(&pc,"f");
        Term t = pc_make_compound(&pc, fid, 2, args);
        assert(TERM_TAG(t)==TAG_COMPOUND && pc_compound_functor(&pc,t)==fid);
        assert(pc_compound_arity(&pc,t)==2 && pc_compound_arg(&pc,t,0)==args[0] && pc_compound_arg(&pc,t,1)==args[1]);
        pass("compound term");
    }
    {
        Term items[3] = { pc_make_atom(&pc,"a"), pc_make_atom(&pc,"b"), pc_make_atom(&pc,"c") };
        Term lst = pc_make_list(&pc, 3, items, TERM_NONE);
        assert(TERM_TAG(lst)==TAG_COMPOUND);
        uint32_t dot = pc_intern_atom(&pc,".");
        assert(pc_compound_functor(&pc,lst)==dot);
        Term head = pc_compound_arg(&pc,lst,0);
        assert(strcmp(pc_atom_name(&pc,ATOM_ID(head)),"a")==0);
        pass("list construction");
    }

    printf("\n=== Unification ===\n");
    { pc_subst_reset(&pc); Term a=pc_make_atom(&pc,"x"); assert(pc_unify(&pc,a,a)); pass("identical atoms"); }
    { pc_subst_reset(&pc); assert(!pc_unify(&pc,pc_make_atom(&pc,"x"),pc_make_atom(&pc,"o"))); pass("different atoms fail"); }
    {
        pc_subst_reset(&pc);
        Term x=TERM_VAR(0), a=pc_make_atom(&pc,"hello_u");
        assert(pc_unify(&pc,x,a)); assert(pc_walk(&pc,x)==a);
        pass("var binds to atom");
    }
    {
        pc_subst_reset(&pc);
        uint32_t fid=pc_intern_atom(&pc,"f");
        Term a1[2]={TERM_VAR(0),pc_make_atom(&pc,"b")}, a2[2]={pc_make_atom(&pc,"a"),TERM_VAR(1)};
        Term t1=pc_make_compound(&pc,fid,2,a1), t2=pc_make_compound(&pc,fid,2,a2);
        assert(pc_unify(&pc,t1,t2));
        assert(strcmp(pc_atom_name(&pc,ATOM_ID(pc_walk(&pc,TERM_VAR(0)))),"a")==0);
        assert(strcmp(pc_atom_name(&pc,ATOM_ID(pc_walk(&pc,TERM_VAR(1)))),"b")==0);
        pass("compound unification");
    }
    {
        pc_subst_reset(&pc);
        Term a[1]={pc_make_atom(&pc,"a")};
        assert(!pc_unify(&pc,
            pc_make_compound(&pc,pc_intern_atom(&pc,"f"),1,a),
            pc_make_compound(&pc,pc_intern_atom(&pc,"g"),1,a)));
        pass("functor mismatch fails");
    }

    printf("\n=== Trail ===\n");
    {
        pc_subst_reset(&pc);
        uint32_t cp=pc_trail_checkpoint(&pc);
        pc_bind(&pc,0,pc_make_atom(&pc,"bound"));
        assert(pc_walk(&pc,TERM_VAR(0))==pc_make_atom(&pc,"bound"));
        pc_trail_undo(&pc,cp);
        assert(pc_walk(&pc,TERM_VAR(0))==TERM_VAR(0));
        pass("trail undo restores");
    }
    {
        pc_subst_reset(&pc);
        uint32_t cp=pc_trail_checkpoint(&pc);
        uint32_t fid=pc_intern_atom(&pc,"f");
        Term a1[2]={TERM_VAR(0),TERM_VAR(1)}, a2[2]={pc_make_atom(&pc,"a"),pc_make_atom(&pc,"b")};
        assert(pc_unify(&pc, pc_make_compound(&pc,fid,2,a1), pc_make_compound(&pc,fid,2,a2)));
        pc_trail_undo(&pc,cp);
        assert(pc_walk(&pc,TERM_VAR(0))==TERM_VAR(0));
        assert(pc_walk(&pc,TERM_VAR(1))==TERM_VAR(1));
        pass("unify then undo");
    }

    printf("\n=== deepWalk ===\n");
    {
        pc_subst_reset(&pc);
        uint32_t fid=pc_intern_atom(&pc,"f");
        Term args[2]={TERM_VAR(0),TERM_VAR(1)};
        Term t=pc_make_compound(&pc,fid,2,args);
        pc_bind(&pc,0,pc_make_atom(&pc,"ra")); pc_bind(&pc,1,pc_make_num(99));
        Term r=pc_deep_walk(&pc,t);
        assert(TERM_TAG(r)==TAG_COMPOUND);
        assert(strcmp(pc_atom_name(&pc,ATOM_ID(pc_compound_arg(&pc,r,0))),"ra")==0);
        assert(NUM_VALUE(pc_compound_arg(&pc,r,1))==99);
        pass("resolves vars in compound");
    }
    {
        pc_subst_reset(&pc);
        Term t=pc_make_atom(&pc,"const");
        assert(pc_deep_walk(&pc,t)==t);
        pass("returns same term if unchanged");
    }

    printf("\n=== freshVars ===\n");
    {
        uint32_t fid=pc_intern_atom(&pc,"f");
        Term ta[2]={TERM_VAR(0),TERM_VAR(1)};
        Term tmpl[1]={pc_make_compound(&pc,fid,2,ta)};
        Term out[1];
        pc_fresh_clause(&pc,tmpl,1,100,out,1);
        assert(VAR_ID(pc_compound_arg(&pc,out[0],0))==100);
        assert(VAR_ID(pc_compound_arg(&pc,out[0],1))==101);
        pass("offsets variable IDs");
    }

    printf("\n=== Lists ===\n");
    {
        pc_subst_reset(&pc);
        Term i1[3]={pc_make_atom(&pc,"a"),TERM_VAR(0),pc_make_atom(&pc,"c")};
        Term i2[3]={TERM_VAR(1),pc_make_atom(&pc,"b"),TERM_VAR(2)};
        assert(pc_unify(&pc, pc_make_list(&pc,3,i1,TERM_NONE), pc_make_list(&pc,3,i2,TERM_NONE)));
        assert(strcmp(pc_atom_name(&pc,ATOM_ID(pc_walk(&pc,TERM_VAR(0)))),"b")==0);
        assert(strcmp(pc_atom_name(&pc,ATOM_ID(pc_walk(&pc,TERM_VAR(1)))),"a")==0);
        assert(strcmp(pc_atom_name(&pc,ATOM_ID(pc_walk(&pc,TERM_VAR(2)))),"c")==0);
        pass("list unification");
    }

    printf("\n%d/%d tests passed\n", tests_passed, tests_run);
    return (tests_passed == tests_run) ? 0 : 1;
}
