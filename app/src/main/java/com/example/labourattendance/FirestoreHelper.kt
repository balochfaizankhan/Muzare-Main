package com.example.labourattendance

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions

class FirestoreHelper {
    private val db = FirebaseFirestore.getInstance()
    private val auth = FirebaseAuth.getInstance()
    private fun tenantCollection(name: String) = db.collection("workspaces")
        .document(requireNotNull(auth.currentUser?.uid) { "Authenticated tenant is required." })
        .collection(name)

    fun syncLabour(labour: DatabaseHelper.Labour) {
        val data = hashMapOf(
            "id" to labour.id,
            "name" to labour.name,
            "groupId" to labour.groupId,
            "wage" to labour.wage,
            "displayOrder" to labour.displayOrder,
            "joinDate" to (labour.joinDate ?: ""),
            "endDate" to (labour.endDate ?: ""),
            "status" to labour.status,
            "farmId" to labour.farmId,
            "labourType" to labour.labourType,
            "remarks" to (labour.remarks ?: "")
        )
        tenantCollection("labours").document(labour.id.toString()).set(data, SetOptions.merge())
    }

    fun deleteLabour(labourId: Int) {
        tenantCollection("labours").document(labourId.toString()).delete()
    }

    fun syncAttendance(entry: DatabaseHelper.AttendanceEntry) {
        val docId = "${entry.labourId}_${entry.date}"
        val data = hashMapOf(
            "labourId" to entry.labourId,
            "date" to entry.date,
            "status" to entry.status,
            "farmId" to entry.farmId
        )
        tenantCollection("attendance").document(docId).set(data, SetOptions.merge())
    }

    fun deleteAttendance(labourId: Int, date: String) {
        val docId = "${labourId}_${date}"
        tenantCollection("attendance").document(docId).delete()
    }

    fun syncAdvance(record: DatabaseHelper.AdvanceRecord) {
        val data = hashMapOf(
            "id" to record.id,
            "labourId" to record.labourId,
            "labourName" to (record.labourName ?: ""),
            "amount" to record.amount,
            "date" to record.date,
            "description" to (record.description ?: ""),
            "sourceId" to record.sourceId,
            "farmId" to record.farmId
        )
        tenantCollection("advances").document(record.id.toString()).set(data, SetOptions.merge())
    }

    fun deleteAdvance(advanceId: Int) {
        tenantCollection("advances").document(advanceId.toString()).delete()
    }

    fun syncGroup(group: DatabaseHelper.Group) {
        val data = hashMapOf(
            "id" to group.id,
            "name" to group.name,
            "farmId" to group.farmId
        )
        tenantCollection("groups").document(group.id.toString()).set(data, SetOptions.merge())
    }

    fun deleteGroup(groupId: Int) {
        tenantCollection("groups").document(groupId.toString()).delete()
    }

    fun syncVoucher(voucher: DatabaseHelper.Voucher) {
        val items = voucher.items.map {
            hashMapOf(
                "category" to it.category,
                "amount" to it.amount,
                "description" to (it.description ?: "")
            )
        }
        val data = hashMapOf(
            "id" to voucher.id,
            "voucherNumber" to voucher.voucherNumber,
            "date" to voucher.date,
            "totalAmount" to voucher.totalAmount,
            "recordedBy" to voucher.recordedBy,
            "sourceId" to voucher.sourceId,
            "sourceName" to (voucher.sourceName ?: ""),
            "items" to items,
            "farmId" to voucher.farmId
        )
        tenantCollection("expenditure").document(voucher.id.toString()).set(data, SetOptions.merge())
    }

    fun deleteVoucher(voucherId: Int) {
        tenantCollection("expenditure").document(voucherId.toString()).delete()
    }

    fun syncFundSource(source: DatabaseHelper.FundSource) {
        val data = hashMapOf(
            "id" to source.id,
            "name" to source.name,
            "description" to (source.description ?: ""),
            "farmId" to source.farmId
        )
        tenantCollection("fund_sources").document(source.id.toString()).set(data, SetOptions.merge())
    }

    fun syncFundEntry(entry: DatabaseHelper.FundEntry) {
        val data = hashMapOf(
            "id" to entry.id,
            "sourceId" to entry.sourceId,
            "sourceName" to (entry.sourceName ?: ""),
            "amount" to entry.amount,
            "date" to entry.date,
            "description" to (entry.description ?: ""),
            "farmId" to entry.farmId
        )
        tenantCollection("fund_entries").document(entry.id.toString()).set(data, SetOptions.merge())
    }

    fun deleteFundEntry(id: Int) {
        tenantCollection("fund_entries").document(id.toString()).delete()
    }

    fun deleteVehicle(id: Int) {
        tenantCollection("vehicles").document(id.toString()).delete()
    }

    fun deleteDateType(id: Int) {
        tenantCollection("dateTypes").document(id.toString()).delete()
    }

    fun deleteDispatch(id: Int) {
        tenantCollection("dispatches").document(id.toString()).delete()
    }

    fun deleteExpCategory(id: Int) {
        tenantCollection("exp_categories").document(id.toString()).delete()
    }

    fun syncExpCategory(cat: DatabaseHelper.ExpCategory) {
        val data = hashMapOf(
            "id" to cat.id,
            "name" to cat.name,
            "farmId" to cat.farmId
        )
        tenantCollection("exp_categories").document(cat.id.toString()).set(data, SetOptions.merge())
    }

    fun syncVehicle(vehicle: DatabaseHelper.Vehicle) {
        val data = hashMapOf(
            "id" to vehicle.id,
            "number" to vehicle.number,
            "driverName" to vehicle.driverName,
            "driverPhone" to vehicle.driverPhone,
            "farmId" to vehicle.farmId
        )
        tenantCollection("vehicles").document(vehicle.id.toString()).set(data, SetOptions.merge())
    }

    fun syncDateType(type: DatabaseHelper.DateType) {
        val data = hashMapOf(
            "id" to type.id,
            "name" to type.name,
            "farmId" to type.farmId
        )
        tenantCollection("dateTypes").document(type.id.toString()).set(data, SetOptions.merge())
    }

    fun syncDispatch(dispatch: DatabaseHelper.DispatchRecord) {
        val items = dispatch.items.map {
            hashMapOf(
                "dateTypeId" to it.dateTypeId,
                "dateTypeName" to it.dateTypeName,
                "cartonCount" to it.cartonCount
            )
        }
        val data = hashMapOf(
            "id" to dispatch.id,
            "vehicleId" to dispatch.vehicleId,
            "vehicleNumber" to dispatch.vehicleNumber,
            "driverName" to dispatch.driverName,
            "date" to dispatch.date,
            "items" to items,
            "farmId" to dispatch.farmId
        )
        tenantCollection("dispatches").document(dispatch.id.toString()).set(data, SetOptions.merge())
    }

    fun syncFarm(farm: DatabaseHelper.Farm) {
        val data = hashMapOf(
            "id" to farm.id,
            "name" to farm.name,
            "location" to (farm.location ?: ""),
            "owner" to (farm.owner ?: ""),
            "remarks" to (farm.remarks ?: ""),
            "activeStatus" to farm.activeStatus,
            "createdBy" to (farm.createdBy ?: ""),
            "timestamp" to farm.timestamp
        )
        tenantCollection("farms").document(farm.id.toString()).set(data, SetOptions.merge())
    }

    fun deleteFarm(farmId: Int) {
        tenantCollection("farms").document(farmId.toString()).delete()
    }

    fun fetchAllFarms(onSuccess: (List<Map<String, Any>>) -> Unit) {
        tenantCollection("farms").get().addOnSuccessListener { result ->
            onSuccess(result.map { it.data })
        }
    }

    fun fetchAllGroups(onSuccess: (List<Map<String, Any>>) -> Unit) {
        tenantCollection("groups").get().addOnSuccessListener { result ->
            onSuccess(result.map { it.data })
        }
    }

    fun fetchAllLabours(onSuccess: (List<Map<String, Any>>) -> Unit) {
        tenantCollection("labours").get().addOnSuccessListener { result ->
            onSuccess(result.map { it.data })
        }
    }

    fun fetchAllAdvances(onSuccess: (List<Map<String, Any>>) -> Unit) {
        tenantCollection("advances").get().addOnSuccessListener { result ->
            onSuccess(result.map { it.data })
        }
    }

    fun fetchAllAttendance(onSuccess: (List<Map<String, Any>>) -> Unit) {
        tenantCollection("attendance").get().addOnSuccessListener { result ->
            onSuccess(result.map { it.data })
        }
    }

    fun fetchAllExpenditure(onSuccess: (List<Map<String, Any>>) -> Unit) {
        tenantCollection("expenditure").get().addOnSuccessListener { result ->
            onSuccess(result.map { it.data })
        }
    }

    fun fetchAllFundSources(onSuccess: (List<Map<String, Any>>) -> Unit) {
        tenantCollection("fund_sources").get().addOnSuccessListener { result ->
            onSuccess(result.map { it.data })
        }
    }

    fun fetchAllFundEntries(onSuccess: (List<Map<String, Any>>) -> Unit) {
        tenantCollection("fund_entries").get().addOnSuccessListener { result ->
            onSuccess(result.map { it.data })
        }
    }

    fun fetchAllVehicles(onSuccess: (List<Map<String, Any>>) -> Unit) {
        tenantCollection("vehicles").get().addOnSuccessListener { result ->
            onSuccess(result.map { it.data })
        }
    }

    fun fetchAllDateTypes(onSuccess: (List<Map<String, Any>>) -> Unit) {
        tenantCollection("dateTypes").get().addOnSuccessListener { result ->
            onSuccess(result.map { it.data })
        }
    }

    fun fetchAllDispatches(onSuccess: (List<Map<String, Any>>) -> Unit) {
        tenantCollection("dispatches").get().addOnSuccessListener { result ->
            onSuccess(result.map { it.data })
        }
    }
}
